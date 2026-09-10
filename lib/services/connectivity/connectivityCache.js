/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The read-through cache the connectivity lookups share.
 *
 * A backlog sweep works through listings in whatever order the database hands them over, and a
 * street that a portal is currently full of produces dozens of listings at the same address. Each
 * of those would otherwise be a separate pair of requests for an answer that cannot differ.
 */

/** @type {Map<string, {expiresAt: number, value: unknown}>} */
const cache = new Map();

/** @type {Map<string, Promise<unknown>>} */
const inFlight = new Map();

/**
 * How long a successful lookup is reused.
 *
 * The registers behind it are updated twice a year, so this is not about freshness - it is about
 * how long one sweep's worth of answers stays around. An hour outlives any sweep and costs
 * nothing.
 */
export const SUCCESS_TTL = 60 * 60 * 1000;

/**
 * How long a failed lookup is reused.
 *
 * Short, because a failure is usually a hiccup rather than a verdict, but not zero: without it a
 * sweep would ask a struggling service once per listing.
 */
export const FAILURE_TTL = 60 * 1000;

/**
 * Decimals coordinates are rounded to for cache keys.
 *
 * Four is about ten metres. Deliberately not the hundred metres of a register cell, tempting as
 * that is: a rounding grid of our own would not line up with theirs, so two listings a stone's
 * throw apart could share a key while genuinely sitting in different cells, and the second one
 * would be told about its neighbour's connection. Ten metres still collapses the case that
 * actually repeats - several flats in the same building, all geocoded to the same point.
 */
export const COORD_PRECISION = 4;

/**
 * Builds the cache key for one lookup.
 *
 * The source is part of the key because a coordinate near a border is in range of two registers,
 * and their answers are not interchangeable.
 *
 * So is the address, for a source that answers by address rather than by point. Ten metres holds
 * several flats in one building for a register asked by coordinate, but it also holds both sides
 * of a street for a checker asked by door number - and a null from one listing's unreadable
 * address would be handed to its neighbour as a verdict. A caller passes the address only for
 * those sources; leaving it out is what says "this answer is about the point".
 *
 * @param {string} sourceId
 * @param {number} lat
 * @param {number} lng
 * @param {string} [address] The listing's address, for a source that reads it.
 * @returns {string}
 */
export function cacheKey(sourceId, lat, lng, address) {
  const point = `${lat.toFixed(COORD_PRECISION)},${lng.toFixed(COORD_PRECISION)}`;
  if (address === undefined) {
    return `${sourceId}:${point}`;
  }
  return `${sourceId}:${point}:${normalizeAddress(address)}`;
}

/**
 * One address written one way, so that the spacing and case a portal happened to print does not
 * split a cache entry in two.
 *
 * @param {unknown} address
 * @returns {string} the empty string for anything that is not an address, which is a key of its
 *   own: a listing with no address is a lookup that cannot be made, and every one of them fails
 *   the same way
 */
function normalizeAddress(address) {
  return typeof address === 'string' ? address.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/** How many entries may sit in the cache before expired ones are swept out. */
const PRUNE_THRESHOLD = 2000;

/**
 * Drops every entry whose lifetime has run out.
 *
 * @returns {void}
 */
function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

/**
 * Reads through the cache, collapsing concurrent misses of the same key into one lookup.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} loader
 * @returns {Promise<T>}
 */
export async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return /** @type {T} */ (hit.value);
  }
  cache.delete(key);

  const running = inFlight.get(key);
  if (running) {
    return /** @type {Promise<T>} */ (running);
  }

  const promise = (async () => {
    const value = await loader();
    if (cache.size >= PRUNE_THRESHOLD) {
      pruneExpired();
    }
    cache.set(key, { expiresAt: Date.now() + (value == null ? FAILURE_TTL : SUCCESS_TTL), value });
    return value;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Drops every cached lookup. Used by the tests, which would otherwise leak state between cases.
 *
 * @returns {void}
 */
export function clearConnectivityCache() {
  cache.clear();
  inFlight.clear();
}
