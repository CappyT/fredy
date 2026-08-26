/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Reads a search url copied out of casa.it into the search its api answers.
 *
 * The portal writes a search in two shapes and both are read here. A search over a town
 * ("/affitto/residenziale/roma/") says everything in its path; a search drawn on the map
 * ("/srp/map/?geopolygon=...") says everything in its query string.
 *
 * What the two have in common is the answer's shape: a `where` saying which ground to search, and
 * `filters` saying what to look for on it.
 *
 * See `reverse-engineered-casa.md`.
 */

import { readFilters } from './search-filters.js';
import { resolvePlace } from './geography.js';
import logger from '../logger.js';

/** The path a search drawn on the map is written at. */
const MAP_SEARCH_PATH = '/srp/map/';

/** The first segment of a search written as a path, and what it means to the api. */
const CONTRACTS = { vendita: 'vendita', affitto: 'affitto' };

/**
 * The second segment, which the website calls a category and the api takes as a group of property
 * kinds. Only the residential one is carried over: it is the group every other entry would have to
 * be confirmed against, and this api answers a group it does not know with the residential one
 * rather than with an error, so an unconfirmed guess is indistinguishable from the truth.
 */
const CATEGORIES = { residenziale: 'case' };

/**
 * @typedef {Object} CasaSearch
 * @property {any[]} where The ground to search.
 * @property {Record<string, any>} filters What to look for on it.
 */

/**
 * The ground a drawn search covers.
 *
 * @param {Record<string, string>} area The url's area parameters, decoded.
 * @returns {any[]|null}
 */
function drawnArea(area) {
  if (area.geopolygon != null) {
    const ring = JSON.parse(area.geopolygon)?.polygon;
    if (!Array.isArray(ring) || ring.length < 3) return null;
    // The url writes a point as [lat, lon] and the api reads it as [lon, lat]. Sent in the url's
    // own order the api answers nothing at all, which reads as a search with no results.
    return [{ geo: { polygon: ring.map(([lat, lon]) => [lon, lat]) } }];
  }

  if (area.geocircle != null) {
    const circle = JSON.parse(area.geocircle);
    const centre = circle?.center ?? circle?.centre;
    if (!Array.isArray(centre) || circle?.radius == null) return null;
    return [{ geo: { center: centre, distance: Number(circle.radius) } }];
  }

  return null;
}

/**
 * @param {string} webUrl A url copied out of casa.it.
 * @returns {Promise<CasaSearch|null>} null when the url names a search the api cannot be asked for
 */
export async function translateSearchUrl(webUrl) {
  let parsed;
  try {
    parsed = new URL(webUrl);
  } catch {
    return null;
  }

  const read = readFilters(parsed.search);
  if (read == null) {
    logger.debug(`Casa.it: ${webUrl} carries a filter with no counterpart; reading the website.`);
    return null;
  }
  const { filters, area } = read;

  if (parsed.pathname === MAP_SEARCH_PATH) {
    const where = drawnArea(area);
    return where == null ? null : { where, filters };
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 3) return null;

  const contract = CONTRACTS[segments[0]];
  const group = CATEGORIES[segments[1]];
  if (contract == null || group == null) return null;

  const place = await resolvePlace(segments[segments.length - 1]);
  if (place == null) {
    logger.debug(`Casa.it: no place is called "${segments[segments.length - 1]}".`);
    return null;
  }

  return {
    where: [{ hkey: place.hkey, level: place.level }],
    // What the url says wins over what its path implied, the way the website reads its own url.
    filters: { 'transaction.type': contract, property_type_group: group, ...filters },
  };
}

export { MAP_SEARCH_PATH };
