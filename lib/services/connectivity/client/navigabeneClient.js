/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fetch from 'node-fetch';
import pThrottle from 'p-throttle';
import logger from '../../logger.js';
import { parseAddress, sameCivic } from '../italianAddress.js';
import { normalizeItalian } from '../normalize.js';

/**
 * Client for the Italian coverage checker behind copertura.navigabene.it.
 *
 * The service answers per address rather than per cell: a street is found by its town's istat code
 * and its name, a civic number by walking the street's own list, and the verdict comes for one
 * building. It names commercial offers rather than a register - "TIM, FTTC, 102 Mbit/s" - so the
 * fastest offer per technology is the reading of what the address can get.
 *
 * There is no key and no session; the only headers it wants are a browser's. An empty answer is
 * still an answer - the address is unserved - and is stored as such; an address the checker
 * refuses is a miss for that one listing, and only the service itself failing stands the client
 * down. See `reverse-engineered-copertura-italia.md` for the measured protocol.
 *
 * The lookup runs on the listing's address rather than its coordinates, which the common contract
 * carries as the third argument: the checker has no way to be asked by point, and an address that
 * reads the way the portals print it - "Via San Francesco, 3, Chiuduno" - is what its own search
 * boxes want anyway.
 */

/** Where the checker's api is served from. */
const API_BASE = 'https://prod01.copertura.contratti.net';

/** The operator the checker answers for. Navigabene's own, as the site's script carries it. */
const OPERATOR_ID = 'b01fdb33-0011-4158-8f90-3702c74d5fae';

/** The service is a plain web frontend's backend, and reads a browser's. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT = 15000;

/**
 * Two requests a second, the same pace the German register is asked at. One listing costs two or
 * three of them - town, street, verdict - and a sweep has a few hundred listings.
 */
const throttle = pThrottle({ limit: 2, interval: 1000 });

/**
 * How long the client stands off after the service failed to answer.
 *
 * Without this a sweep with a few hundred listings would keep asking a service that has already
 * said no, which is both pointless and the behaviour most likely to get this installation blocked.
 */
const PAUSE_DURATION = 15 * 60 * 1000;

let pausedSince = 0;

/** How many resolved places and streets stay in memory. Streets do not move; the cap is a formality. */
const MAX_CACHE_ENTRIES = 2000;

/** @type {Map<string, {istat: string, town: string}|null>} The towns that have been looked up. */
const towns = new Map();

/** @type {Map<string, {particella: string, strada: string, egon: string, civico: string}|null>} The streets. */
const streets = new Map();

/**
 * Whether the client is currently standing off after a failure.
 *
 * A sweep checks this before each listing so that a dead service costs one request per run rather
 * than one per listing.
 *
 * @returns {boolean}
 */
export function isNavigabenePaused() {
  return Date.now() - pausedSince < PAUSE_DURATION;
}

/**
 * Clears the client's memory of failures, places and streets. Only used by the tests.
 *
 * @returns {void}
 */
export function resetNavigabeneClient() {
  pausedSince = 0;
  towns.clear();
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
 * 401 and 403 are the ones that matter in practice: there is no key to get wrong here, so a
 * checker that starts answering 401 or 403 is a front door that has been shut - a WAF that has
 * decided it does not like this user agent, an operator id that has been retired - and it will
 * answer the same way for every address until somebody changes something. 407 is a proxy in front
 * of this installation demanding credentials, and 451 is the whole service withdrawn for legal
 * reasons; neither says anything about the door number that happened to be asked for. 429 and the
 * 5xx range complete the list: had enough of us, or unwell.
 * @type {Set<number>}
 */
const BLOCKING_STATUSES = new Set([401, 403, 407, 429, 451]);

/**
 * Whether a refusal is the service's problem rather than this one request's.
 *
 * The distinction is what keeps one odd address from costing a sweep its remaining lookups, and -
 * read the other way round - what keeps a shut door from being written into the database as a few
 * hundred unserved addresses. The checker answers 404 for a street it has never heard of and 400
 * for a civic number it cannot read; 410 and 422 belong with them. Every one of those is a verdict
 * about the address that was asked for: the listing gets no connectivity line and the sweep
 * carries on. Everything in `BLOCKING_STATUSES`, and every 5xx, is the service refusing this
 * installation rather than answering, and that is what the stand-off is for - a sweep stamps up to
 * a couple of hundred listings in a run, and stamping them all "unserved" for half a year because
 * a WAF spent an hour answering 403 is the failure this list exists to prevent.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isServiceFailure(status) {
  return BLOCKING_STATUSES.has(status) || status >= 500;
}

/**
 * Runs a GET and parses the body as JSON.
 *
 * The body is fetched inside the transport's try and parsed outside it, which is not a stylistic
 * choice: the catch stands the whole source down, and that is the right answer for a socket that
 * died and the wrong one for a 200 carrying something that is not JSON. An api host behind a
 * frontend can answer an error page, a cache's holding page or a PHP notice with a 200, and
 * reading that as an outage would stand the source down for a quarter of an hour over one bad
 * reply about one address.
 *
 * @param {string} path The path and query, already encoded.
 * @returns {Promise<unknown|null>} `null` for every failure - a listing without connectivity data
 *   is a listing that renders one line less, never a broken pipeline.
 */
async function getJson(path) {
  let body;

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      const message = `The Italian coverage checker responded with ${response.status} ${response.statusText}`;
      if (isServiceFailure(response.status)) {
        logger.error(message);
        pausedSince = Date.now();
      } else {
        // One address the checker cannot answer for, which is a miss and not an outage. Logged at
        // debug because a sweep of a few hundred listings will always turn up a handful of them.
        logger.debug(message);
      }
      return null;
    }

    body = await response.text();
  } catch (error) {
    logger.error('Error during Italian coverage request:', error);
    pausedSince = Date.now();
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    // A 200 whose body is not JSON. That is this one request wasted, nothing more: the source is
    // answering, so the next address gets asked.
    logger.debug(`The Italian coverage checker answered ${path} with a body that is not JSON.`);
    return null;
  }
}

const throttledGetJson = throttle(getJson);

/**
 * The street prefixes the checker's own search splits off before looking.
 *
 * The frontend keeps this list to guess where the street's name starts in what the user typed; the
 * backend's street search matches nothing once a particella it does not expect rides in front, so
 * the same split happens here. The list is the frontend's own, verbatim.
 * @type {string[]}
 */
const PARTICELLE = [
  'VIA',
  'VIALE',
  'CORSO',
  'PIAZZA',
  'PIAZZALE',
  'VICOLO',
  'STRADA',
  'STRADONE',
  'LARGO',
  'GALLERIA',
  'RIONE',
  'ROTONDA',
  'SALITA',
  'DISCESA',
  'CONTRADA',
  'BORGO',
  'PASSAGGIO',
  'RAMPE',
  'TRAVERSA',
  'SENTIERO',
  'ARGINE',
  'CALATA',
  'FONDAMENTA',
  'RUGA',
  'CAMPO',
  'CALLE',
  'RIO TERÀ',
  'SESTIERE',
  'ISOLA',
  'PARCO',
  'BELVEDERE',
  'LUNGOMARE',
  'LUNGARNO',
  'LUNGOTEVERE',
  'LITORANEA',
];

/**
 * Splits a street into its particella and its name, as the checker's searches want them.
 *
 * @param {string} street The street as the address spells it, "Via San Francesco".
 * @returns {{particella: string, strada: string}} The particella defaults to the checker's own
 *   catch-all - "STREET" is what its search answers for a street whose prefix is none of the list -
 *   and the whole name stays with the street in that case.
 */
function splitStreet(street) {
  const upper = street.toUpperCase();
  const words = upper.split(' ');
  if (words.length > 1 && PARTICELLE.includes(words[0])) {
    return { particella: words[0], strada: words.slice(1).join(' ') };
  }
  return { particella: 'STREET', strada: upper };
}

/**
 * The town a listing sits in, as the checker names it.
 *
 * @param {string} name The town as the address spells it.
 * @returns {Promise<{istat: string, town: string}|null>} null when the checker knows no town by
 *   that name
 */
async function lookupTown(name) {
  const key = name.trim().toLowerCase();
  if (towns.has(key)) return /** @type {{istat: string, town: string}|null} */ (towns.get(key));

  const answer = await throttledGetJson(`/copertura/city/${encodeURI(name)}`);
  if (answer == null) return null;

  const found = Array.isArray(answer?.results) ? answer.results : [];
  const town =
    found.find((entry) => String(entry?.name ?? '').toLowerCase() === key) ??
    found.find((entry) => typeof entry?.istat_code === 'string');
  if (town == null) return remember(towns, key, null);

  return remember(towns, key, { istat: town.istat_code, town: town.name });
}

/**
 * The street a listing stands on, by its town and name.
 *
 * @param {string} istat
 * @param {string} name The street as the address spells it, particella included - the search
 *   matches over the whole of what it is given.
 * @returns {Promise<{particella: string, strada: string, egon: string, civico: string}|null>} the
 *   street with its first civic number's building id, or null when the checker knows no street by
 *   that name in that town
 */
async function lookupStreet(istat, name) {
  const key = `${istat}|${name.trim().toLowerCase()}`;
  if (streets.has(key)) return /** @type {any} */ (streets.get(key));

  const { strada } = splitStreet(name);
  const answer = await throttledGetJson(`/copertura/street/${encodeURI(istat)}/${encodeURI(strada)}`);
  const found = answer == null ? null : Array.isArray(answer?.results) ? answer.results : [];

  // An address that kept the typology it was cut from - "Villa in Via San Francesco" - names the
  // street only after the "in". The particella form is what is searched first, and the street name
  // alone is what saves the lookup.
  let street = found?.find((entry) => typeof entry?.egon === 'string' || typeof entry?.egon === 'number');
  const afterIn = strada.lastIndexOf(' IN ');
  if (street == null && afterIn >= 0) {
    const retried = splitStreet(strada.slice(afterIn + 4).trim());
    const retriedAnswer = await throttledGetJson(`/copertura/street/${encodeURI(istat)}/${encodeURI(retried.strada)}`);
    const retriedFound =
      retriedAnswer == null ? [] : Array.isArray(retriedAnswer?.results) ? retriedAnswer.results : [];
    street = retriedFound.find((entry) => typeof entry?.egon === 'string' || typeof entry?.egon === 'number');
  }
  if (street == null) return remember(streets, key, null);

  return remember(streets, key, {
    particella: String(street.particella),
    strada: String(street.strada),
    egon: String(street.egon),
    civico: String(street.civico ?? ''),
  });
}

/**
 * The building id of one civic number on a street the checker knows.
 *
 * The number is asked for by its numeric part alone. A civic number with a pairing on it - "1/X",
 * "12/A", which is how they are printed and what `parseAddress` hands over - carries a slash that
 * the checker reads as one more path segment, and the request comes back 404 for an address that
 * exists (`encodeURIComponent` fares no better: the escaped slash is a 400). Asked for "1" it
 * answers with the street's list around that number, the paired ones included, so the pairing is
 * matched in the answer rather than in the request.
 *
 * @param {{istat: string, particella: string, strada: string}} street
 * @param {string} civic
 * @returns {Promise<{egon: string, civico: string}|null>} the building and the number the checker
 *   names it by, or null when the street's list names no such number - which is where the street's
 *   own civic number takes over
 */
async function lookupBuilding(street, civic) {
  const number = civic.match(/^\s*\d+/)?.[0].trim() ?? civic;
  const answer = await throttledGetJson(
    `/copertura/street/${encodeURI(street.istat)}/${encodeURI(street.particella)}/${encodeURI(
      street.strada,
    )}/${encodeURI(number)}`,
  );
  if (answer == null) return null;

  const found = Array.isArray(answer?.results) ? answer.results : [];
  // The pairing first - "1/X" is a different door from "1" - and the bare number as the fallback,
  // which is the whole answer for a street that does not pair its numbers at all.
  const building =
    found.find((entry) => sameCivic(String(entry?.civico ?? ''), civic)) ??
    found.find((entry) => sameCivic(String(entry?.civico ?? ''), number));
  return building == null ? null : { egon: String(building.egon), civico: String(building.civico) };
}

/**
 * The request path for one building's verdict, the checker reads its own context back out of.
 *
 * The trailing part is the address the checker itself would assemble, base64-encoded - it carries
 * the civic number and the town's name the search resolved, so the answer says what it was asked
 * about.
 *
 * @param {{egon: string, istat: string, particella: string, civico: string, strada: string, town: string}} context
 * @returns {string}
 */
export function coveragePath(context) {
  const context64 = Buffer.from(
    JSON.stringify({
      particella: context.particella,
      civico: context.civico,
      strada: context.strada,
      codice_istat: context.istat,
      comune: context.town,
    }),
  ).toString('base64');
  return `/copertura/get/${OPERATOR_ID}/${context.egon}/${context.istat}/${encodeURIComponent(context64)}`;
}

/**
 * Looks up what fixed line one italian address can get.
 *
 * An address without a civic number is answered for its street's first building, which is the same
 * verdict as long as the street is served uniformly - and is the best the checker can be asked
 * without a door number, since its search is per building. A civic number the street does not list
 * falls back the same way.
 *
 * @param {number} _lat Present because the common contract carries it; the checker cannot be asked
 *   by point.
 * @param {number} _lng As above.
 * @param {string|undefined} address The listing's address, as the portal printed it.
 * @returns {Promise<import('../normalize.js').Connectivity|null>} the verdict, or null when the
 *   lookup could not be made - the service failed, or the address names no town or street it knows
 */
export async function fetchItalianConnectivity(_lat, _lng, address) {
  const parsed = parseAddress(address);
  if (parsed == null) return null;

  const town = await lookupTown(parsed.town);
  if (town == null) return null;

  const street = await lookupStreet(town.istat, parsed.street);
  if (street == null) return null;

  let egon = street.egon;
  let civico = street.civico;
  if (parsed.civic != null) {
    const building = await lookupBuilding(
      { istat: town.istat, particella: street.particella, strada: street.strada },
      parsed.civic,
    );
    if (building != null) {
      egon = building.egon;
      civico = building.civico;
    }
  }

  const answer = await throttledGetJson(
    coveragePath({
      egon,
      istat: town.istat,
      particella: street.particella,
      civico,
      strada: street.strada,
      town: town.town,
    }),
  );
  if (answer == null) return null;

  return normalizeItalian(answer?.results);
}
