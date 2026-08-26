/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * What a search url's parameters mean to the search api.
 *
 * The table is not guesswork: casa.it ships the converter that writes these urls in
 * `/portal-srp/common-*.js`, and this is that mapping read backwards.
 *
 * A parameter missing from here is not passed through and not ignored - the whole url is left
 * untranslated and read off the website instead. That is the opposite of what the sibling provider
 * for immobiliare.it does, and for a measured reason: this api drops a filter name it does not know
 * without a word, so a name we get wrong widens the search in silence. There the endpoint refuses
 * and says so, and can be trusted to judge its own parameters. Here it cannot.
 *
 * See `reverse-engineered-casa.md`.
 */

/** Parameters that bound a figure: the url names each end, the api takes one object with both. */
const RANGES = {
  priceMin: ['price', 'gte'],
  priceMax: ['price', 'lte'],
  mqMin: ['surface', 'gte'],
  mqMax: ['surface', 'lte'],
  numRoomsMin: ['rooms', 'gte'],
  numRoomsMax: ['rooms', 'lte'],
  mqpriceMin: ['mqprice', 'gte'],
  mqpriceMax: ['mqprice', 'lte'],
  paymentMin: ['payment', 'gte'],
  paymentMax: ['payment', 'lte'],
  buildingYearMin: ['building_year', 'gte'],
  buildingYearMax: ['building_year', 'lte'],
  numParkingSpaces: ['carparks', 'gte'],
};

/** Parameters the url writes as a comma-joined list and the api takes as an array. */
const LISTS = {
  propertyTypes: 'property.types',
  buildingCondition: 'building_condition',
  garden: 'garden.type',
  heatingType: 'heating.types',
};

/**
 * Parameters that carry one value. Several of these answer a list with a bare "Internal Server
 * Error" rather than with a message, so the shape matters as much as the name.
 */
const SCALARS = {
  tr: 'transaction.type',
  propertyTypeGroup: 'property_type_group',
  rentType: 'rent_type',
  energyClass: 'energy_class',
  publicationDt: 'publication_date',
  sellerType: 'publisher',
  photo: 'only_with_photos',
  pId: 'publisher.id',
};

/**
 * Set per request rather than per search, so the url's own value for them is dropped. The sort is
 * one of these: the pipeline appends it to the url in the website's spelling, and the api has a
 * spelling of its own that the caller sets.
 */
const PER_REQUEST = ['page', 'sortType'];

/** Named where the search happens rather than what is searched for, and read by the translator. */
export const AREA_PARAMS = ['geopolygon', 'geocircle', 'geobounds', 'nearby'];

/**
 * Whether a value is a figure the api wants as a number rather than as text.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isNumber(raw) {
  return /^-?\d+(\.\d+)?$/.test(raw);
}

/**
 * Write one value the way casa.it writes it.
 *
 * The website has an encoder of its own - accents stripped, an apostrophe turned into a space, a
 * comma into `%2C`, a space into `+` - and the api is fed the result of it verbatim. So a value has
 * to reach the api in that spelling however the url happened to carry it: a job's url passes
 * through a rewriter on its way here, which turns the `+` back into `%20`, and `casa%20indipendente`
 * matches nothing while `casa+indipendente` matches the houses. Neither is reported as an error.
 *
 * @param {string} raw One value, exactly as the url carries it.
 * @returns {string} the same value in the spelling the api answers to
 */
export function toApiValue(raw) {
  // `+` means a space in a query string, which `decodeURIComponent` does not know.
  const decoded = decodeURIComponent(String(raw).replace(/\+/g, '%20'));
  return decoded
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/'/g, ' ')
    .replace(/,/g, '%2C')
    .replace(/ /g, '+');
}

/**
 * Split one list-valued parameter.
 *
 * The website joins the items with a comma and escapes it, so the separator in the url is `%2C`
 * while a `+` inside an item is left as it is. Splitting on a literal comma finds nothing to split
 * and hands the api one long value, which it accepts and matches nothing with.
 *
 * @param {string} raw The value exactly as the url carries it.
 * @returns {string[]}
 */
function splitList(raw) {
  return raw
    .split(/%2C|,/i)
    .map((item) => toApiValue(item.trim()))
    .filter(Boolean);
}

/**
 * Translate the query string of a search url.
 *
 * Values are taken exactly as the url carries them, undecoded. The website encodes a value with an
 * encoder of its own - accents stripped, an apostrophe turned into a space, a space into `+` and a
 * comma into `%2C` - and the api is fed the result of that verbatim. A value decoded on the way
 * through therefore stops matching: `casa+indipendente` finds the houses, `casa indipendente`
 * finds none of them, and neither is reported as an error.
 *
 * @param {string} query The url's query string, with or without its leading `?`.
 * @returns {{filters: Record<string, any>, area: Record<string, string>}|null} the api filters and
 *   the untranslated area parameters, or null when the url names a filter this cannot carry over
 */
export function readFilters(query) {
  /** @type {Record<string, any>} */
  const filters = {};
  /** @type {Record<string, string>} */
  const area = {};

  for (const pair of String(query).replace(/^\?/, '').split('&')) {
    if (pair === '') continue;
    const separator = pair.indexOf('=');
    const name = decodeURIComponent(separator < 0 ? pair : pair.slice(0, separator));
    const raw = separator < 0 ? '' : pair.slice(separator + 1);

    if (PER_REQUEST.includes(name)) continue;
    if (AREA_PARAMS.includes(name)) {
      area[name] = decodeURIComponent(raw);
      continue;
    }

    if (RANGES[name] != null) {
      const [key, bound] = RANGES[name];
      filters[key] = { ...(filters[key] ?? {}), [bound]: isNumber(raw) ? Number(raw) : toApiValue(raw) };
    } else if (LISTS[name] != null) {
      filters[LISTS[name]] = [...(filters[LISTS[name]] ?? []), ...splitList(raw)];
    } else if (SCALARS[name] != null) {
      filters[SCALARS[name]] = toApiValue(raw);
    } else {
      return null;
    }
  }

  return { filters, area };
}
