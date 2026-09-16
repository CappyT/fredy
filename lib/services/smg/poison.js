/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The poison detector both Swiss SMG providers share.
 *
 * The search and detail endpoints of `api.homegate.ch` and `api.immoscout24.ch` answer two value
 * sets for the same request. The honest set is the real listing; the poisoned set rewrites every
 * number (rooms divided by about three, rent multiplied by about 1.23, living space shrunk or
 * inflated), rewrites the title and description to match, and removes `prices.rent.net` from every
 * row. The split is random per response - roughly one answer in three to five is honest - and does
 * not depend on the user agent, the TLS fingerprint or the DataDome cookie.
 *
 * The free text cannot tell the two sets apart, so the detector compares the answer against the
 * request that produced it. Two signals are used:
 *
 * 1. A rent search that is expected to return residential listings keeps `prices.rent.net` on every
 *    honest row. When every rent row of a page has that field removed, the page is poisoned. The
 *    signal is blind on a commercial-only search, where both value sets lack it.
 * 2. The poisoned numbers violate the request's own numeric filters and sort: a `numberOfRooms`
 *    filter of 3 cannot answer a 1-room row, and a `numberOfRooms` sort cannot step backwards.
 *
 * The detector is conservative in the direction that protects the user: it never calls a page
 * honest when it has no signal to stand on. Such a page is `unknown`. Only a poisoned page is
 * dropped: an unknown one is kept, because a search that sets no numeric filter - an unfiltered
 * purchase search is one - would otherwise store nothing at all. The caller says once that it could
 * not verify the page.
 *
 * @module smg/poison
 */

/**
 * A page whose rows carry the honest values.
 * @type {'honest'}
 */
export const HONEST = 'honest';

/**
 * A page whose rows carry the rewritten values.
 * @type {'poisoned'}
 */
export const POISONED = 'poisoned';

/**
 * A page the detector cannot judge: it has no rent net price and no numeric filter to check.
 * @type {'unknown'}
 */
export const UNKNOWN = 'unknown';

/**
 * How many times one page is requested before the read gives up on it.
 *
 * One honest answer in three to five makes a handful of attempts enough, and the cap bounds the
 * requests one run spends when the endpoint serves nothing but poison.
 */
export const MAX_VERIFY_ATTEMPTS = 7;

/**
 * How much a value may leave its filter bound before the row is a violation. The portal rounds, so
 * a small slack keeps an honest row from being read as poisoned.
 */
const EPSILON = 1e-6;

/**
 * How far the room sort may step backwards before the page is a violation. Room counts are halves,
 * so half a room of slack absorbs a tie the server ordered by its own second key.
 */
const SORT_TOLERANCE = 0.51;

/**
 * The numeric filters and the listing field each one bounds.
 *
 * Only the fields whose name is live-confirmed on both hosts appear here. A field the listing does
 * not carry is skipped, so this never turns a missing value into a violation.
 *
 * @type {Array<[string, (listing: any) => number|null|undefined]>}
 */
const RANGE_FIELDS = [
  ['numberOfRooms', (listing) => listing?.characteristics?.numberOfRooms],
  ['livingSpace', (listing) => listing?.characteristics?.livingSpace],
  ['lotSize', (listing) => listing?.characteristics?.lotSize],
  ['cubage', (listing) => listing?.characteristics?.cubage],
  ['yearBuilt', (listing) => listing?.characteristics?.yearBuilt],
  ['yearlyRentPerSqm', (listing) => listing?.characteristics?.yearlyRentPerSqm],
  [
    'totalFloorSpace',
    (listing) => listing?.characteristics?.totalFloorSpace ?? listing?.characteristics?.usableFloorSpace,
  ],
];

/**
 * The listing payload of one search result.
 *
 * Homegate answers `{ listing: {...} }` per result and ImmoScout24.ch answers the listing itself
 * inside `{ listing: {...} }` as well. A bare listing is accepted too, so the detector does not
 * depend on the wrapper.
 *
 * @param {any} entry one result of a search answer
 * @returns {any|null}
 */
function listingOf(entry) {
  return entry?.listing ?? entry ?? null;
}

/**
 * The identity a violation is reported with.
 *
 * @param {any} listing
 * @returns {string}
 */
function idOf(listing) {
  const id = listing?.id;
  return id == null ? '?' : String(id);
}

/**
 * Whether a value is inside a `{from, to}` range, either bound absent.
 *
 * @param {number} value
 * @param {{from?: number, to?: number}} range
 * @returns {boolean}
 */
function within(value, range) {
  if (range?.from != null && value < range.from - EPSILON) return false;
  if (range?.to != null && value > range.to + EPSILON) return false;
  return true;
}

/**
 * The price values of one listing the request's price filter may be measured against.
 *
 * The API does not say whether `monthlyRent` bounds the net or the gross figure, so a rent row is
 * accepted when either is inside. A purchase row has one price.
 *
 * @param {any} listing
 * @param {Object} query the request's query
 * @returns {number[]}
 */
function priceValues(listing, query) {
  if (query?.purchasePrice != null) {
    const price = listing?.prices?.buy?.price;
    return price == null ? [] : [price];
  }
  return [listing?.prices?.rent?.net, listing?.prices?.rent?.gross].filter((value) => value != null);
}

/**
 * Find a row that breaks a numeric filter or the room sort the request named.
 *
 * @param {any[]} rows the listing payloads of one page
 * @param {Object} query the request's query
 * @returns {{violation: string|null, checked: string[]}} the first violation, and the filters that
 *   were evaluated
 */
function findViolation(rows, query) {
  const checked = [];

  for (const [field, read] of RANGE_FIELDS) {
    const range = query?.[field];
    if (range == null) continue;
    const bounded = rows
      .map((listing) => ({ id: idOf(listing), value: read(listing) }))
      .filter((row) => row.value != null);
    if (bounded.length === 0) continue;
    checked.push(field);
    for (const row of bounded) {
      if (!within(row.value, range)) {
        return {
          violation: `${field}=${row.value} on listing ${row.id} breaks ${JSON.stringify(range)}`,
          checked,
        };
      }
    }
  }

  const priceRange = query?.monthlyRent ?? query?.purchasePrice;
  if (priceRange != null) {
    const priced = rows
      .map((listing) => ({ id: idOf(listing), values: priceValues(listing, query) }))
      .filter((row) => row.values.length > 0);
    if (priced.length > 0) {
      checked.push('price');
      for (const row of priced) {
        if (!row.values.some((value) => within(value, priceRange))) {
          return {
            violation: `price=${row.values.join('/')} on listing ${row.id} breaks ${JSON.stringify(priceRange)}`,
            checked,
          };
        }
      }
    }
  }

  if (query?.sortBy === 'numberOfRooms' && rows.length > 2) {
    const rooms = rows.map((listing) => listing?.characteristics?.numberOfRooms);
    if (rooms.every((value) => value != null)) {
      checked.push('sort');
      const direction = query.sortDirection === 'asc' ? 1 : -1;
      // The first row is skipped: a promoted top listing may stand before the sorted ones without
      // the page being poisoned. The rewrite divides the rooms, which keeps their order, so this
      // signal is a weak one and is kept deliberately shy of a false alarm.
      for (let index = 2; index < rooms.length; index++) {
        if (direction * (rooms[index] - rooms[index - 1]) < -SORT_TOLERANCE) {
          return {
            violation: `numberOfRooms ${query.sortDirection ?? 'desc'} breaks at ${rooms[index - 1]} then ${rooms[index]}`,
            checked,
          };
        }
      }
    }
  }

  return { violation: null, checked };
}

/**
 * Decide whether one search answer carries honest values, rewritten values, or nothing the detector
 * can judge.
 *
 * @param {Object} input
 * @param {any[]} input.listings the `results` of one search answer
 * @param {Object} input.query the request's query, as it was sent
 * @param {boolean} [input.expectNet] whether the search is expected to answer residential rent rows
 *   that keep `prices.rent.net`. False on a commercial-only search, whose rows lack the field in
 *   both value sets and where the first signal is blind.
 * @returns {{verdict: 'honest'|'poisoned'|'unknown', reason: string}}
 */
export function detectPoison({ listings = [], query = {}, expectNet = false } = {}) {
  const rows = (Array.isArray(listings) ? listings : []).map(listingOf).filter((listing) => listing != null);
  if (rows.length === 0) return { verdict: HONEST, reason: 'the page is empty, so it carries no rewritten row' };

  const rentRows = rows.filter((listing) => listing?.prices?.rent != null);
  const netRows = rentRows.filter((listing) => listing?.prices?.rent?.net != null);

  if (expectNet && rentRows.length > 0 && netRows.length === 0) {
    return { verdict: POISONED, reason: `all ${rentRows.length} rent rows lost prices.rent.net` };
  }

  const { violation, checked } = findViolation(rows, query);
  if (violation != null) return { verdict: POISONED, reason: violation };

  const signals = [];
  if (netRows.length > 0) signals.push(`${netRows.length} of ${rentRows.length} rent rows keep prices.rent.net`);
  if (checked.length > 0) signals.push(`the rows hold ${checked.join(', ')}`);

  if (signals.length === 0) {
    return { verdict: UNKNOWN, reason: 'no rent net price and no numeric filter to hold the page against' };
  }
  return { verdict: HONEST, reason: signals.join('; ') };
}

/**
 * Read one page, repeat the same request while the answer is poisoned, and give back the honest
 * answer when one arrives.
 *
 * An unknown verdict is not retried: the detector has no signal on that page, so the same request
 * would answer the same unknown seven times.
 *
 * The same body is sent every time: only the endpoint's random honest/poisoned split changes
 * between two identical requests. The request function owns the token path, so a retry reuses the
 * DataDome cookie the first attempt carried and pays no second solve.
 *
 * @param {Object} input
 * @param {(body: Object) => Promise<any|null>} input.requestPage asks the endpoint for one page
 * @param {Object} input.body the request body to send, unchanged on every attempt
 * @param {Object} input.query the request's query, for the detector
 * @param {boolean} [input.expectNet] see {@link detectPoison}
 * @returns {Promise<{answer: any|null, verdict: {verdict: string, reason: string}|null, attempts: number}>}
 *   the last answer (`null` when the endpoint never answered), its verdict (`null` then), and how
 *   many requests were made
 */
export async function readVerifiedPage({ requestPage, body, query, expectNet = false }) {
  let answer = await requestPage(body);
  let attempts = 1;
  if (answer == null) return { answer: null, verdict: null, attempts };

  let verdict = detectPoison({ listings: answer.results, query, expectNet });
  while (verdict.verdict === POISONED && attempts < MAX_VERIFY_ATTEMPTS) {
    answer = await requestPage(body);
    attempts++;
    if (answer == null) return { answer: null, verdict: null, attempts };
    verdict = detectPoison({ listings: answer.results, query, expectNet });
  }

  return { answer, verdict, attempts };
}
