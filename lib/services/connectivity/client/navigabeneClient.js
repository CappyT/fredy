/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fetch from 'node-fetch';
import pThrottle from 'p-throttle';
import logger from '../../logger.js';
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
 * still an answer - the address is unserved - and is stored as such, where a failure stands the
 * client down instead. See `reverse-engineered-copertura-italia.md` for the measured protocol.
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
 * How long the client stands off after the service refused or failed to answer.
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
 * Runs a GET and parses the body as JSON.
 *
 * @param {string} path The path and query, already encoded.
 * @returns {Promise<unknown|null>} `null` for every failure - a listing without connectivity data
 *   is a listing that renders one line less, never a broken pipeline.
 */
async function getJson(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      logger.error(`The Italian coverage checker responded with ${response.status} ${response.statusText}`);
      pausedSince = Date.now();
      return null;
    }

    return await response.json();
  } catch (error) {
    logger.error('Error during Italian coverage request:', error);
    pausedSince = Date.now();
    return null;
  }
}

const throttledGetJson = throttle(getJson);

/**
 * Reads the address a listing carries into the three parts the checker asks for.
 *
 * An italian listing address reads "Via San Francesco, 3, Chiuduno" - street, civic number when
 * there is one, town - and sometimes a district sits between the street and the town ("Via Tito
 * Vignoli s.n.c, Lorenteggio, Milano"). The town is the last comma part, a trailing bare number is
 * the civic number, and the part in between is a district the checker has no word for.
 *
 * A civic number can also ride on the street itself, "Via Al Poggio 1/X, Ranzanico", and is lifted
 * off for the same reason: the checker wants the street's name to find the street and the civic
 * number to find the building, and neither search reads the other's half.
 *
 * "s.n.c" (senza numero civico) rides on the street name; the checker matches street names
 * prefix-first and the marker itself names nothing, so it is dropped rather than searched for.
 *
 * @param {string|undefined} address
 * @returns {{street: string, civic: string|null, town: string}|null} null when the address does not
 *   even name a street and a town, which is the checker's minimum
 */
export function parseAddress(address) {
  if (typeof address !== 'string' || address.trim() === '') return null;

  const parts = address
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return null;

  const town = parts.pop();

  /** A civic number is a number, with an optional letter or pairing on it: "3", "12/A", "1-X". */
  const civicPattern = /^\d+(?:\s*[/\\-]\s*[0-9a-z]+)?$/i;
  let civic = null;
  if (civicPattern.test(parts[parts.length - 1])) {
    civic = parts.pop();
  }

  // Whatever sits between the street and the town - "Lorenteggio" - is a district. Only the first
  // part names a street; the checker would not know what to do with the rest.
  let street = parts[0].replace(/\s+s\.?n\.?c\.?\s*$/i, '').trim();

  if (civic == null) {
    const trailing = street.match(/\s(\d+(?:\s*[/\\-]\s*[0-9a-z]+)?)$/i);
    if (trailing != null) {
      civic = trailing[1];
      street = street.slice(0, trailing.index).trim();
    }
  }

  if (street === '') return null;

  return { street, civic, town };
}

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
 * @param {{istat: string, particella: string, strada: string}} street
 * @param {string} civic
 * @returns {Promise<string|null>} the building id, or null when the street's list names no such
 *   number - which is where the street's own civic number takes over
 */
async function lookupBuilding(street, civic) {
  const answer = await throttledGetJson(
    `/copertura/street/${encodeURI(street.istat)}/${encodeURI(street.particella)}/${encodeURI(
      street.strada,
    )}/${encodeURI(civic)}`,
  );
  if (answer == null) return null;

  const found = Array.isArray(answer?.results) ? answer.results : [];
  const building = found.find((entry) => String(entry?.civico ?? '').toLowerCase() === civic.toLowerCase());
  return building == null ? null : String(building.egon);
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
      egon = building;
      civico = parsed.civic;
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
