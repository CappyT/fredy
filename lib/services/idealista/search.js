/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Runs a search against the idealista mobile api.
 *
 * The api takes what the website will not: it sorts by publication date. The website's robots.txt
 * disallows that sort, which is why reading the site means walking the whole result set in the
 * portal's own ranking and hoping the new advert is somewhere in it. Here the newest advert is the
 * first one on the first page, so a run reads the few pages that can hold everything published
 * since the run before it.
 *
 * A search is asked for by place where the url names one, by outline where it names areas in the
 * website's own shorthand - see `./zones.js` - and by the polygon itself where the user drew one on
 * the map. Where the url names several building conditions, or the "Appartamenti" box the api
 * serves one shape of home at a time, the api is asked once per value and the answers are merged.
 */

import { call, MAX_ITEMS_PER_PAGE, SEARCH_PATH } from './mobile-api.js';
import { resolveLocationId } from './locations.js';
import { locationsOf, multiPolygonOf, outlineOf, parseOutline } from './zones.js';
import { translateSearchUrl } from './web-translator.js';
import logger from '../logger.js';

/**
 * How many pages of a date-ordered search one run reads.
 *
 * The first page holds the fifty newest adverts, which is more than a search collects between two
 * runs of a job. A variant whose head is deeper - a wide search that already holds hundreds of
 * adverts when the job starts - is caught up whole the first time this process runs the url, and
 * from then on the head is the only traffic there is. The adverts carry no date a watermark could
 * be taken from, so the catch-up is keyed on the process having run the search at all: a restart
 * pays one thorough run per search again.
 */
const MAX_PAGES = 3;
const CATCHUP_PAGES = 12;

/** The urls this process has already run to the end. */
const caughtUp = new Set();

/**
 * The parameters every search sends, whatever the url asked for.
 *
 * `quality` and `gallery` are what makes the answer carry a description and a photo; without them
 * the api serves a shorter advert that Fredy has less to show and less to deduplicate on.
 *
 * @type {Array<[string, string]>}
 */
const COMMON_PARAMS = [
  ['order', 'publicationDate'],
  ['sort', 'desc'],
  ['locale', 'it'],
  ['quality', 'high'],
  ['gallery', 'true'],
  ['maxItems', String(MAX_ITEMS_PER_PAGE)],
];

/**
 * @typedef {{searchType: string, params: Array<[string, string]>}} SearchArea Where to search, and
 *   under which search type the api reads it.
 */

/**
 * Read one page of a search.
 *
 * @param {SearchArea} area
 * @param {import('./web-translator.js').WebSearch} search
 * @param {Array<[string, string]>} filters One of the search's parameter sets.
 * @param {number} page Counted from one.
 * @returns {Promise<any>} the api's answer
 */
function readPage(area, search, filters, page) {
  return call(SEARCH_PATH, {
    query: [
      ['adIds', ''],
      ['searchType', area.searchType],
    ],
    body: [
      ['operation', search.operation],
      ['propertyType', search.propertyType],
      ...area.params,
      ['numPage', String(page)],
      ...COMMON_PARAMS,
      ...filters,
    ],
  });
}

/**
 * Work out where a translated url searches.
 *
 * @param {import('./web-translator.js').WebSearch} search
 * @returns {Promise<SearchArea|null>} null when the place cannot be pinned down
 */
async function areaOf(search) {
  if (search.drawnShape != null) {
    // The polygon the user drew, in the very encoding the tile host serves borders in.
    const rings = parseOutline(search.drawnShape);
    if (rings.length === 0) return null;
    return { searchType: 'drawn', params: [['shape', JSON.stringify(multiPolygonOf(rings))]] };
  }

  if (search.locationCodes.length > 0) {
    // The locations behind the codes are the search the website runs. Their borders are only the
    // shape of it, so they are used where a code cannot be named - a new area the portal has drawn
    // but has no adverts in yet.
    const locations = await locationsOf(search.locationCodes, search);
    if (locations != null) {
      return { searchType: 'locationIds', params: [['locationIds', `[${locations.join(',')}]`]] };
    }

    const outline = await outlineOf(search.locationCodes);
    if (outline == null) return null;
    logger.debug('Idealista: searching the borders of the areas, having failed to name them.');
    return { searchType: 'drawn', params: [['shape', JSON.stringify(outline)]] };
  }

  const locationId = await resolveLocationId(search.locationSlugs, search);
  if (locationId == null) return null;
  return { searchType: 'locationIds', params: [['locationIds', `[${locationId}]`]] };
}

/**
 * Run a search the api can answer.
 *
 * @param {string} webUrl The job's search url, as it was copied off the website.
 * @returns {Promise<any[]|null>} the adverts, newest first, or null when the url names a search the
 *   api cannot be asked for and the website has to be read instead
 */
export async function searchListings(webUrl) {
  const search = translateSearchUrl(webUrl);
  if (search == null) {
    logger.debug(`Idealista: ${webUrl} names a search the mobile api has no terms for; reading the website.`);
    return null;
  }

  const area = await areaOf(search);
  if (area == null) {
    logger.debug(`Idealista: the api knows no area called "${webUrl}"; reading the website instead.`);
    return null;
  }

  const adverts = [];
  const seen = new Set();
  const fresh = !caughtUp.has(webUrl);
  const pageCap = fresh ? CATCHUP_PAGES : MAX_PAGES;

  for (const filters of search.variants) {
    for (let page = 1; page <= pageCap; page++) {
      const answer = await readPage(area, search, filters, page);
      const found = Array.isArray(answer?.elementList) ? answer.elementList : [];

      for (const advert of found) {
        if (advert?.propertyCode == null || seen.has(advert.propertyCode)) continue;
        seen.add(advert.propertyCode);
        adverts.push(advert);
      }

      if (found.length < MAX_ITEMS_PER_PAGE || page >= (answer?.totalPages ?? 0)) break;
    }
  }

  caughtUp.add(webUrl);
  return adverts;
}

/**
 * Forget which searches have been caught up. Exists for the tests.
 *
 * @returns {void}
 */
export function clearCaughtUpSearches() {
  caughtUp.clear();
}

/**
 * Read one advert by the code that names it on the website.
 *
 * The search endpoint answers by id as readily as by place, which is what lets a stored listing be
 * checked - and priced again - without rendering the page it came from.
 *
 * @param {string} propertyCode
 * @returns {Promise<any|null>} the advert, or null when idealista no longer carries it
 */
export async function readAdvert(propertyCode) {
  const answer = await call(SEARCH_PATH, {
    query: [['adIds', String(propertyCode)]],
    body: [
      ['operation', 'sale'],
      ['propertyType', 'homes'],
      ['locale', 'it'],
      ['numPage', '1'],
      ['maxItems', '1'],
    ],
  });

  // An advert is returned whatever operation and property type the query names - both are required
  // parameters that the id makes moot - so the answer is empty only when the advert is gone.
  return answer?.elementList?.[0] ?? null;
}
