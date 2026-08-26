/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Turns the place a search url names into the key the search api filters by.
 *
 * The api names a place with an opaque `hkey` and the level it sits at, and a url names it in
 * words. The id casa.it prints elsewhere (`IT-LAZ-058091`) is not accepted: sent as `id` it is
 * ignored in silence and the search widens to the whole country, which is the worst kind of wrong.
 * Only `hkey` works.
 *
 * The lookup is the same autocomplete the app's search box uses. It needs no key and no session.
 *
 * See `reverse-engineered-casa.md`.
 */

import logger from '../logger.js';

const SUGGEST_URL = 'https://smartsuggest.casa.it/smartsuggest/v1/suggest/';

/** The catalogue to look places up in. */
const SITE = 'it_casa';

/**
 * What the api calls each level of the hierarchy. A name alone does not identify a place - Roma is
 * both a province and the town in it - so the level has to be chosen rather than ranked.
 */
export const LEVELS = { region: 4, province: 6, town: 9, zone: 10, subzone: 11 };

/**
 * Places already resolved, shared by every job. A town keeps its key.
 *
 * @type {Map<string, Promise<{hkey: string, level: number}|null>>}
 */
const places = new Map();

/**
 * The words a url spells a place with, as a name to look up.
 *
 * @param {string} slug
 * @returns {string}
 */
export function toQuery(slug) {
  return String(slug).replace(/-/g, ' ').trim();
}

/**
 * @param {any} place
 * @param {string} slug
 * @returns {boolean} whether this is the place the url spells that way
 */
function matches(place, slug) {
  // One place, one slug, and it arrives as a string rather than as the list its plural name
  // suggests.
  const slugs = String(place?.slugs ?? '')
    .split(',')
    .map((entry) => entry.trim());
  if (slugs.includes(slug)) return true;

  const name = String(place?.name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name === slug;
}

/**
 * Look a place up by the name a url spells it with.
 *
 * @param {string} slug
 * @param {number[]} levels The levels worth accepting, in the order the url makes them likely.
 * @returns {Promise<{hkey: string, level: number}|null>}
 */
async function lookUp(slug, levels) {
  const url = new URL(SUGGEST_URL);
  url.searchParams.set('query', toQuery(slug));
  url.searchParams.set('site', SITE);

  const response = await fetch(url);
  if (!response.ok) {
    logger.warn(`Casa.it: the place lookup answered ${response.status} for "${slug}".`);
    return null;
  }

  const found = (await response.json())?.data?.results;
  const candidates = (Array.isArray(found) ? found : []).filter((place) => matches(place, slug));
  for (const level of levels) {
    const place = candidates.find((candidate) => Number(candidate?.level) === level);
    if (place?.hkey != null) return { hkey: String(place.hkey), level };
  }
  return null;
}

/**
 * Resolve one place named in a url.
 *
 * @param {string} slug
 * @param {number[]} [levels] Which levels to accept, most likely first.
 * @returns {Promise<{hkey: string, level: number}|null>}
 */
export function resolvePlace(slug, levels = [LEVELS.town, LEVELS.province, LEVELS.region, LEVELS.zone]) {
  const key = `${slug}|${levels.join(',')}`;
  if (!places.has(key)) {
    places.set(
      key,
      lookUp(slug, levels).catch((error) => {
        places.delete(key);
        throw error;
      }),
    );
  }
  return /** @type {Promise<{hkey: string, level: number}|null>} */ (places.get(key));
}

/**
 * Forget the places resolved so far. Exists for the tests, which serve their own.
 *
 * @returns {void}
 */
export function clearPlaceCache() {
  places.clear();
}
