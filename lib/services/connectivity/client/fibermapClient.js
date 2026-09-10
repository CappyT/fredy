/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fetch from 'node-fetch';
import pThrottle from 'p-throttle';
import logger from '../../logger.js';
import { parseAddress, parseLabel, normalizeName, sameCivic } from '../italianAddress.js';
import { normalizeFibermap } from '../normalize.js';

/**
 * Client for the coverage aggregator behind fibermap.it.
 *
 * Where Navigabene answers with one reseller's catalogue, fibermap answers with the wholesale
 * networks themselves: FiberCop, Open Fiber, Fastweb, EOLO and OpNet, each with the technology it
 * reaches the building on and what it sells there. That makes it the better answer for a flat -
 * "FTTH from FiberCop and Open Fiber" is a fact about the address, where "TIM sells FTTC here" is
 * a fact about one shop - and it is why the two italian sources are alternatives rather than a
 * pair.
 *
 * It is a WordPress plugin's ajax endpoint, so everything goes through one URL and the `type`
 * field of the answer says what came back. There is no key and no session. What there is, and what
 * shapes this client, is a per-IP quota on the coverage step: five verdicts and the sixth answers
 * `{"status":"blocked"}` while the address search carries on working. That is treated exactly like
 * a 429 - the source stands down and the sweep moves on - and it is why the address is resolved in
 * as few requests as it can be, and why a whole street's door numbers are remembered from the one
 * request that lists them.
 *
 * See `reverse-engineered-copertura-italia.md` for the measured protocol.
 */

/** The plugin's ajax endpoint. Everything - search and verdict - is a GET against this. */
const API_URL = 'https://fibermap.it/wp-admin/admin-ajax.php';

/** The plugin's action and the one call it exposes. */
const ACTION = 'fbc_ajax_call';
const ACT = 'resolveAddress';

/**
 * Which catalogue the answer is assembled for.
 *
 * A listing is somebody's flat, so the consumer catalogue is the one that describes what can
 * actually be ordered at the door. The measured answers carry both halves whichever is asked for,
 * and this client reads the shared half regardless; the field is sent because the site's own form
 * refuses to search without it.
 */
const CUSTOMER_TYPE = 'privato';

/** A plain web frontend's backend, and it reads a browser's. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT = 20000;

/**
 * One request a second.
 *
 * Half the pace the other registers are asked at, because this one is a small site's WordPress
 * install rather than a national register, and because its coverage quota is measured in single
 * figures: going faster would not buy a single extra verdict.
 */
const throttle = pThrottle({ limit: 1, interval: 1000 });

/**
 * How long the client stands off after the service refused.
 *
 * Four times the other clients' quarter of an hour, because the refusal that actually happens here
 * is a quota rather than an outage - the service is perfectly well, it has simply had this
 * installation's share for now, and asking again in fifteen minutes would only spend the next one.
 */
const PAUSE_DURATION = 60 * 60 * 1000;

let pausedSince = 0;

/** How many resolved streets and buildings stay in memory. */
const MAX_CACHE_ENTRIES = 2000;

/** @type {Map<string, string|null>} Building id per address, the street's whole list at a time. */
const buildings = new Map();

/** @type {Map<string, {id: string, label: string}|null>} Street id per street and town. */
const streets = new Map();

/**
 * Whether the client is currently standing off after a refusal.
 *
 * A sweep checks this before each listing, so a quota that has run out costs one request per run
 * rather than one per listing.
 *
 * @returns {boolean}
 */
export function isFibermapPaused() {
  return Date.now() - pausedSince < PAUSE_DURATION;
}

/**
 * Clears the client's memory of failures, streets and buildings. Only used by the tests.
 *
 * @returns {void}
 */
export function resetFibermapClient() {
  pausedSince = 0;
  buildings.clear();
  streets.clear();
}

/**
 * @template V
 * @param {Map<string, V>} cache
 * @param {string} key
 * @param {V} value
 * @returns {V}
 */
function remember(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * The statuses that are about this installation rather than about an address.
 *
 * The same list the Navigabene client keeps, for the same reason and with rather more chance of
 * firing: this is a WordPress install, and the thing most likely to sit in front of one is a
 * security plugin or a CDN that decides a scripted user agent is not welcome and answers 403 to
 * everything for the next hour. 401 goes with it, 407 is a proxy in front of this installation,
 * and 451 is the service withdrawn wholesale. None of them is a statement about a door number.
 * @type {Set<number>}
 */
const BLOCKING_STATUSES = new Set([401, 403, 407, 429, 451]);

/**
 * Whether a refusal is the service's problem rather than this one request's.
 *
 * The same distinction the other clients draw, and for the same reason in both directions: one odd
 * address must not cost a sweep its remaining lookups, and a front door shut against this
 * installation must not be written down as a couple of hundred unserved flats. A 400, 404, 410 or
 * 422 is a verdict about the request that was made - the listing gets no connectivity line and the
 * sweep carries on - while everything in `BLOCKING_STATUSES` and every 5xx says the service is
 * unwell, has had enough of us, or is not letting us in at all, which is what the stand-off is
 * for.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isServiceFailure(status) {
  return BLOCKING_STATUSES.has(status) || status >= 500;
}

/**
 * @typedef {Object} FibermapAnswer
 * @property {string} type What came back: `street`, `building` or `coverage`.
 * @property {unknown} data The suggestions, or the verdict.
 */

/**
 * Asks the endpoint one question.
 *
 * The plugin answers 200 for everything, including its own refusals, so the http status is only
 * half the reading: a body whose `status` is `blocked` is the per-IP coverage quota talking, and
 * that is a 429 in all but name.
 *
 * Which is also why the body is fetched inside the transport's try and parsed outside it. The
 * catch stands the source down for an hour, and `admin-ajax.php` is the one endpoint in the world
 * most likely to answer a bare `0`, a PHP warning or a fragment of the admin page with a 200 - the
 * handler declining, not the site falling over. Reading that as an outage would be self-inflicted:
 * a paused source leaves the listing unstamped, unstamped listings sort first, and the one bad
 * reply would come back around to pause the source again on every sweep from here on, with every
 * older listing behind it never reached.
 *
 * @param {string} input The query, a street id or a building id, depending on `type`.
 * @param {'default'|'street'|'building'} type What `input` is.
 * @param {string} label The label the previous step printed, as the site's own form sends it.
 * @returns {Promise<FibermapAnswer|null>} `null` for every failure - a listing without
 *   connectivity data is a listing that renders one line less, never a broken pipeline.
 */
async function ask(input, type, label) {
  const query = new URLSearchParams({
    action: ACTION,
    act: ACT,
    input,
    type,
    label,
    tipoCliente: CUSTOMER_TYPE,
  });

  let raw;

  try {
    const response = await fetch(`${API_URL}?${query}`, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Referer: 'https://fibermap.it/',
      },
    });

    if (!response.ok) {
      const message = `The Italian coverage aggregator responded with ${response.status} ${response.statusText}`;
      if (isServiceFailure(response.status)) {
        logger.error(message);
        pausedSince = Date.now();
      } else {
        // One address it cannot answer for, which is a miss and not an outage. Logged at debug
        // because a sweep of a few hundred listings will always turn up a handful of them.
        logger.debug(message);
      }
      return null;
    }

    raw = await response.text();
  } catch (error) {
    logger.error('Error during Italian coverage aggregator request:', error);
    pausedSince = Date.now();
    return null;
  }

  /** @type {{status?: string, type?: string, data?: unknown}} */
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // A 200 that is not JSON. One request wasted, and nothing at all about the next address.
    logger.debug(`The Italian coverage aggregator answered ${type} with a body that is not JSON.`);
    return null;
  }

  if (body?.status === 'blocked') {
    logger.error('The Italian coverage aggregator has blocked this address for now.');
    pausedSince = Date.now();
    return null;
  }

  if (body?.status !== 'ok' || typeof body?.type !== 'string') {
    logger.debug(`The Italian coverage aggregator answered ${JSON.stringify(body?.status)}.`);
    return null;
  }

  return { type: body.type, data: body.data };
}

const throttledAsk = throttle(ask);

/**
 * The suggestions out of an answer, as a list.
 *
 * The endpoint prints its suggestions as an id-to-label object and an empty one as an empty array,
 * so both shapes have to be read and only one of them carries anything.
 *
 * @param {unknown} data
 * @returns {Array<{id: string, label: string}>}
 */
function suggestions(data) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }
  return Object.entries(data).map(([id, label]) => ({ id, label: String(label) }));
}

/**
 * The query the address search is given.
 *
 * The form's own placeholder is "via Pola 1, Milano", and that is the shape the search reads best:
 * the street with its door number, then the town.
 *
 * @param {import('../italianAddress.js').ItalianAddress} parsed
 * @returns {string}
 */
function addressQuery(parsed) {
  return parsed.civic == null ? `${parsed.street}, ${parsed.town}` : `${parsed.street} ${parsed.civic}, ${parsed.town}`;
}

/**
 * The suggestion that is actually the address that was asked about.
 *
 * This is the whole of what keeps the source honest. The search is fuzzy and always answers with
 * something: asked for "Via Roma 1, Milano", a street Milano does not have, it offers Via Giulio
 * Romano, Viale Romagna and Via Quinto Romano. Taking the first of those would report a stranger's
 * fibre as this flat's, so a suggestion counts only when its street and its town are the ones that
 * were asked for, spelling and accents aside, and when its door number is the one that was asked
 * for where the address named one.
 *
 * A particella that does not match is a different street and not a spelling - Brescia has a Corso
 * and a Piazzale Garibaldi, and they are two places - so "Via Garibaldi" finding neither is the
 * right answer rather than a gap worth closing.
 *
 * @param {Array<{id: string, label: string}>} entries
 * @param {import('../italianAddress.js').ItalianAddress} parsed
 * @returns {{id: string, label: string}|null}
 */
function pickAddress(entries, parsed) {
  const street = normalizeName(parsed.street);
  const town = normalizeName(parsed.town);

  const onStreet = entries.filter((entry) => {
    const candidate = parseLabel(entry.label);
    return candidate != null && normalizeName(candidate.street) === street && normalizeName(candidate.town) === town;
  });

  if (parsed.civic == null) {
    // Without a door number the street's first building is the best the aggregator can be asked
    // for, the same way the other italian checker answers - its search is per building, and a
    // building it must be given.
    return onStreet[0] ?? null;
  }

  return onStreet.find((entry) => sameCivic(parseLabel(entry.label)?.civic, parsed.civic)) ?? null;
}

/**
 * The key one street is remembered under.
 *
 * @param {import('../italianAddress.js').ItalianAddress} parsed
 * @returns {string}
 */
function streetKey(parsed) {
  return `${normalizeName(parsed.street)}|${normalizeName(parsed.town)}`;
}

/**
 * The key one address is remembered under.
 *
 * @param {import('../italianAddress.js').ItalianAddress} parsed
 * @returns {string}
 */
function buildingKey(parsed) {
  const civic = parsed.civic == null ? '' : parsed.civic.replace(/\s+/g, '').toUpperCase();
  return `${streetKey(parsed)}|${civic}`;
}

/**
 * Remembers which of a set of suggestions is the street that was asked about.
 *
 * @param {import('../italianAddress.js').ItalianAddress} parsed
 * @param {Array<{id: string, label: string}>} entries
 * @returns {{id: string, label: string}|null}
 */
function rememberStreet(parsed, entries) {
  return remember(streets, streetKey(parsed), pickAddress(entries, { ...parsed, civic: null }));
}

/**
 * The street a listing stands on, by its name and town.
 *
 * @param {import('../italianAddress.js').ItalianAddress} parsed
 * @returns {Promise<{id: string, label: string}|null>}
 */
async function lookupStreet(parsed) {
  const key = streetKey(parsed);
  if (streets.has(key)) return /** @type {{id: string, label: string}|null} */ (streets.get(key));

  const answer = await throttledAsk(`${parsed.street}, ${parsed.town}`, 'default', '');
  if (answer == null) return null;
  if (answer.type !== 'street') return remember(streets, key, null);

  return rememberStreet(parsed, suggestions(answer.data));
}

/**
 * The building id of one address.
 *
 * Asked in one request where it can be: the address search reads "Via Al Poggio 1/X, Ranzanico"
 * whole and answers with buildings. Where that turns up nothing - the search caps its suggestions
 * at ten, and a busy street name pushes the right door out of them - the street is resolved
 * instead and asked for its own list of door numbers, which comes back complete. Every door on
 * that list is remembered, so the second listing on the same street costs one request rather than
 * three.
 *
 * @param {import('../italianAddress.js').ItalianAddress} parsed
 * @returns {Promise<string|null>}
 */
async function lookupBuilding(parsed) {
  const key = buildingKey(parsed);
  if (buildings.has(key)) return /** @type {string|null} */ (buildings.get(key));

  // An address with no door number has nothing for the address search to narrow: it would answer
  // with the street, which is the next request's question anyway. Where there is one, the search
  // usually answers the whole thing in that single request - and where it answers with streets
  // instead, that answer is the street lookup and is kept rather than asked for again.
  if (parsed.civic != null) {
    const direct = await throttledAsk(addressQuery(parsed), 'default', '');
    if (direct == null) return null;
    if (direct.type === 'building') {
      const found = pickAddress(suggestions(direct.data), parsed);
      if (found != null) return remember(buildings, key, found.id);
    } else if (direct.type === 'street') {
      rememberStreet(parsed, suggestions(direct.data));
    }
  }

  const street = await lookupStreet(parsed);
  if (street == null) return remember(buildings, key, null);

  const list = await throttledAsk(street.id, 'street', street.label);
  if (list == null) return null;
  if (list.type !== 'building') return remember(buildings, key, null);

  const entries = suggestions(list.data);
  // The whole street arrived in one answer, so every door on it is remembered rather than only the
  // one that was asked for. A portal that is currently full of one street then costs one request.
  for (const entry of entries) {
    const candidate = parseLabel(entry.label);
    if (candidate != null) {
      remember(buildings, buildingKey(candidate), entry.id);
    }
  }

  const found = pickAddress(entries, parsed);
  return remember(buildings, key, found?.id ?? null);
}

/**
 * Looks up what fixed line one italian address can get, as the networks themselves report it.
 *
 * @param {number} _lat Present because the common contract carries it; the aggregator cannot be
 *   asked by point.
 * @param {number} _lng As above.
 * @param {string|undefined} address The listing's address, as the portal printed it.
 * @returns {Promise<import('../normalize.js').Connectivity|null>} the verdict, or null when the
 *   lookup could not be made - the service refused, or no building it knows is the one the address
 *   names
 */
export async function fetchItalianFibermapConnectivity(_lat, _lng, address) {
  const parsed = parseAddress(address);
  if (parsed == null) return null;

  const building = await lookupBuilding(parsed);
  if (building == null) return null;

  const answer = await throttledAsk(building, 'building', addressQuery(parsed));
  if (answer == null || answer.type !== 'coverage') return null;

  return normalizeFibermap(/** @type {any} */ (answer.data)?.network);
}
