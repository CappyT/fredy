/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Reads a search url copied out of idealista.it into the terms the mobile api searches by.
 *
 * ```
 * https://www.idealista.it/affitto-case/milano-milano/centro-storico/con-prezzo_1200,ascensori/
 * -> { operation: 'rent', propertyType: 'homes',
 *      locationSlugs: ['milano-milano', 'centro-storico'], locationCodes: [],
 *      variants: [[['maxPrice', '1200'], ['elevator', '1']]] }
 * ```
 *
 * The whole search sits in the path: the category first, the place next, and the filters in one
 * `con-...` segment at the end. The query string carries the sort order and the map's viewport,
 * neither of which changes which adverts a search holds, so it is ignored.
 *
 * A search over several areas at once is a `/multi/` url, and it names them in a shorthand of its
 * own - `/multi/vendita-case/a5W,a7j/`. Nothing translates those three-letter codes: they are not
 * in the api's catalogue, not in the page's markup and not an encoding of anything. They are
 * reported as they are, and the caller resolves them by other means.
 *
 * A url this cannot read in full is answered with null rather than in part, and the caller reads
 * the website for that search instead. See `./search-filters.js` for what is translated.
 */

import { readCategory, readFilters } from './search-filters.js';

/** How the paginator names a page after the first. */
const PAGE_SEGMENT = /^lista-\d+\.htm$/;

/** The prefix the website puts in front of a search shown in another language. */
const LANGUAGE_SEGMENT = /^[a-z]{2}$/;

/** What a filter segment starts with, in every language the website serves. */
const FILTER_PREFIX = 'con-';

/** The first segment of a search over several areas at once. */
const MULTI_SEGMENT = 'multi';

/**
 * @typedef {Object} WebSearch
 * @property {string} operation `sale` or `rent`.
 * @property {string} propertyType The api's name for the category.
 * @property {string[]} locationSlugs The place, outermost first, as the url spells it. Empty for a
 *   `/multi/` search, which names its areas in codes instead.
 * @property {string[]} locationCodes The shorthand codes of a `/multi/` search, empty otherwise.
 * @property {Array<Array<[string, string]>>} variants One api parameter set per search that has to
 *   be run. More than one only where the url names several building conditions, which the api
 *   takes one at a time.
 */

/**
 * @param {string} webUrl A url copied out of idealista.it.
 * @returns {WebSearch|null} null when the url names a search the api cannot be asked for
 */
export function translateSearchUrl(webUrl) {
  let parsed;
  try {
    parsed = new URL(webUrl);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length > 0 && LANGUAGE_SEGMENT.test(segments[0])) segments.shift();
  if (segments.length > 0 && PAGE_SEGMENT.test(segments.at(-1) ?? '')) segments.pop();

  const multiZone = segments[0] === MULTI_SEGMENT;
  if (multiZone) segments.shift();

  const category = readCategory(segments.shift() ?? '');
  if (category == null) return null;

  const filterSegment = (segments.at(-1) ?? '').startsWith(FILTER_PREFIX) ? (segments.pop() ?? '') : '';
  const variants = readFilters(filterSegment);
  if (variants == null || segments.length === 0) return null;

  if (multiZone) {
    // A multi search names every area in one segment, and nothing may follow it.
    if (segments.length > 1) return null;
    return { ...category, locationSlugs: [], locationCodes: segments[0].split(','), variants };
  }

  return { ...category, locationSlugs: segments, locationCodes: [], variants };
}
