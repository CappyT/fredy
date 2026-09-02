/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Idealista's own web-url parser, reached over the api.
 *
 * The app opens idealista.it links by handing the url to `deeplinks/parse/search` and reading back
 * the search the portal itself sees in it: every filter named in the api's own vocabulary, the
 * areas of a `/multi/` url resolved to their location ids, the polygon of a drawn url decoded into
 * the GeoJSON the search takes. One request replaces the whole local translation, and no website
 * filter can lack a counterpart, because the mapping is the portal's own - `giardino-privato`
 * arrived as `privateGarden` this way, a name no rendered page ever spelled out.
 *
 * Two fields of the answer are legacy copies and are dropped: a `preservation` holding the first
 * value of `preservations`, and a `newDevelopment` boolean saying the same thing again. The list is
 * what the search endpoint reads.
 *
 * A `flat` swallows the narrower flat shapes - `flat=1` answers every flat the website's
 * "Appartamenti" box means, penthouses and two-level flats included, which was measured live by
 * walking both searches and diffing the property codes - so a `flat` is not split into the shapes
 * it already holds. The houses' `subTypology` rides along in the same request: the search honours
 * the two beside each other, and their union is exactly the search the url asked for.
 *
 * The parser resolves no slug url to its location id - a `/multi/` url's codes and a drawn url's
 * polygon it does resolve - so the place of a named search is read locally, the way the fallback
 * translation would.
 */

import { call } from './mobile-api.js';
import { resolveLocationId } from './locations.js';
import { placeOf } from './web-translator.js';
import logger from '../logger.js';

/** The endpoint that reads a website url the way the portal does. */
const PARSE_PATH = '/api/3.5/it/deeplinks/parse/search';

/** Booleans naming the shape of a home. One search honours one of them; their answers merge. */
const SHAPES = ['penthouse', 'duplex', 'studio', 'chalet', 'countryHouse', 'duplexTriplex'];

/** Filters carrying one plain value, sent as the string it already is. */
const SCALARS = ['maxPrice', 'minPrice', 'minSize', 'maxSize', 'bedrooms', 'bathrooms', 'furnished', 'auction'];

/** Filters the api reads as a comma list, which is the union of their values. */
const LISTS = ['preservations', 'energyEfficiency', 'floorHeights'];

/** Filters that are either set or not, sent as `1`. */
const SWITCHES = [
  'garage',
  'elevator',
  'swimmingPool',
  'airConditioning',
  'storeRoom',
  'builtinWardrobes',
  'garden',
  'privateGarden',
  'communityGarden',
  'petsAllowed',
  'terrance',
  'balcony',
  'luxury',
  'seaViews',
  'exterior',
  'accessible',
  'hasPlan',
  'virtualTour',
  'independentHotWater',
  'exteriorDomesticSpace',
  'hasParking',
  'singleParkingSpace',
  'doubleParkingSpace',
  'outdoorCoveredParkingSpace',
  'outdoorUncoveredParkingSpace',
];

/**
 * The searches one parsed filter asks for.
 *
 * A `flat` covers every flat shape and takes the houses' `subTypology` beside it, so a url naming
 * appartamenti and houses is one request. Without a `flat`, each shape is its own search - the api
 * reads one shape of home per request - and the `subTypology` stands alone. A url naming neither is
 * a single search without a shape.
 *
 * @param {any} filter the filter object the parser answered with
 * @returns {Array<Array<[string, string]>>} one parameter set per search to run
 */
function variantsOf(filter) {
  /** @type {Array<[string, string]>} */
  const common = [];
  for (const name of SCALARS) {
    const value = filter[name];
    if (typeof value === 'string' && value !== '') common.push([name, value]);
    else if (typeof value === 'number' && Number.isFinite(value)) common.push([name, String(value)]);
  }
  for (const name of LISTS) {
    const value = filter[name];
    if (Array.isArray(value) && value.length > 0) common.push([name, value.join(',')]);
  }
  for (const name of SWITCHES) {
    if (filter[name] === true) common.push([name, '1']);
  }
  // The kitchen's furnishing travels in the `furnished` parameter, whose value the search reads -
  // the boolean field of the same name is the parser's spelling of the tick, not a parameter.
  if (filter.furnishedKitchen === true) common.push(['furnished', 'furnishedKitchen']);

  const subTypology =
    Array.isArray(filter.subTypology) && filter.subTypology.length > 0
      ? /** @type {[string, string]} */ (['subTypology', filter.subTypology.join(',')])
      : null;

  if (filter.flat === true) {
    return [subTypology == null ? [...common, ['flat', '1']] : [...common, ['flat', '1'], subTypology]];
  }

  const variants = SHAPES.filter((name) => filter[name] === true).map((shape) => [...common, [shape, '1']]);
  if (subTypology != null) variants.push([...common, subTypology]);
  return variants.length > 0 ? variants : [common];
}

/**
 * Where a parsed search looks.
 *
 * @param {any} filter the filter object the parser answered with
 * @param {string} webUrl the url it was parsed from, whose slugs name the place when the parser
 *   carries none
 * @param {{operation: string, propertyType: string}} criteria what the search is for
 * @returns {Promise<{searchType: string, params: Array<[string, string]>}|null>} the area, or null
 *   when neither the parser nor the local catalogue can name it
 */
async function areaOf(filter, webUrl, criteria) {
  if (filter.shape != null && typeof filter.shape === 'object') {
    return { searchType: 'drawn', params: [['shape', JSON.stringify(filter.shape)]] };
  }
  if (Array.isArray(filter.locationIds) && filter.locationIds.length > 0) {
    return { searchType: 'locationIds', params: [['locationIds', `[${filter.locationIds.join(',')}]`]] };
  }

  const place = placeOf(webUrl);
  if (place?.locationSlugs.length > 0) {
    const locationId = await resolveLocationId(place.locationSlugs, criteria);
    if (locationId != null) {
      return { searchType: 'locationIds', params: [['locationIds', `[${locationId}]`]] };
    }
  }
  return null;
}

/**
 * @typedef {Object} ParsedSearch
 * @property {import('./web-translator.js').WebSearch} search The parsed search, in the shape the
 *   local translation returns.
 * @property {{searchType: string, params: Array<[string, string]>}|null} area Where it searches,
 *   null when the place could not be named and the fallback has to try its own ways.
 */

/**
 * Ask idealista to read a search url.
 *
 * @param {string} webUrl The job's search url, as it was copied off the website.
 * @returns {Promise<ParsedSearch|null>} null when the parser could not be asked, or answered
 *   nothing that can be searched by
 */
export async function parseSearchUrl(webUrl) {
  /** @type {any} */
  let answer;
  try {
    answer = await call(PARSE_PATH, { query: [['locale', 'it'], ['url', webUrl]], method: 'GET' });
  } catch (error) {
    logger.debug(`Idealista's parser did not answer (${error.message}); translating locally.`);
    return null;
  }

  const filter = answer?.filter;
  if (answer?.target !== 'listing' || filter == null || typeof filter !== 'object') {
    logger.debug(`Idealista's parser answered a search it cannot serve (target ${answer?.target}).`);
    return null;
  }
  if (typeof filter.operation !== 'string' || typeof filter.propertyType !== 'string') {
    logger.debug("Idealista's parser answered without an operation or a property type.");
    return null;
  }

  const criteria = { operation: filter.operation, propertyType: filter.propertyType };
  return {
    search: {
      operation: criteria.operation,
      propertyType: criteria.propertyType,
      locationSlugs: [],
      locationCodes: [],
      drawnShape: undefined,
      variants: variantsOf(filter),
    },
    area: await areaOf(filter, webUrl, criteria),
  };
}
