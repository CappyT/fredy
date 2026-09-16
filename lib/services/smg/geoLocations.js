/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The location autocomplete both Swiss SMG portals answer in the same way.
 *
 * Homegate and ImmoScout24.ch run the same server code, so `GET /geo/locations` is one endpoint on
 * two hosts with one response model and one meaning. A pasted search URL names a place with the
 * slug its own `urlNames` block carries, and the search query wants the `id` of that same place.
 *
 * The endpoint is an autocomplete, so the answer to one name holds every place that matches it.
 * The live answer to `Zuerich` holds 67 places: the city, the canton, the district and dozens of
 * zip codes. Only the entry whose `urlNames` or `is24UrlNames` spells the FULL slug of the URL is
 * that URL's place. Any other entry is a different place, so a fallback to the first result is
 * never taken: a wrong place searches a different town and says nothing about it.
 *
 * The endpoint is open. It answers a request with no cookie, no signature and no app user agent,
 * so this module sends none.
 */

import logger from '../logger.js';
import { SOLVE_USER_AGENT } from '../datadome.js';

const REQUEST_HEADERS = {
  Accept: 'application/json',
  'User-Agent': SOLVE_USER_AGENT,
};

/**
 * The names to ask the autocomplete for, derived from the URL slug.
 *
 * A slug is a kind and a place - `luogo-chiasso` is the Italian `luogo` for the place `Chiasso` -
 * so the place name alone is asked for first, because that is what the autocomplete indexes. The
 * full slug is asked for as a second candidate: a place whose own name carries a hyphen has no
 * kind prefix, and only the full slug finds it.
 *
 * @param {string} slug the location as the search URL wrote it (`luogo-chiasso`)
 * @returns {string[]} one or two names, in the order to ask for them
 */
function candidateNames(slug) {
  const at = slug.indexOf('-');
  return at > 0 ? [slug.slice(at + 1), slug] : [slug];
}

/**
 * Every name the entry is known by, in the spellings of both portals.
 *
 * @param {any} geoLocation one `results[].geoLocation` object
 * @returns {string[]} the `urlNames` and `is24UrlNames` values, as they stand
 */
function urlNamesOf(geoLocation) {
  return [...Object.values(geoLocation?.urlNames ?? {}), ...Object.values(geoLocation?.is24UrlNames ?? {})];
}

/**
 * The id of the entry whose names spell the slug.
 *
 * @param {any} answer the parsed location response
 * @param {string} slug the location as the search URL wrote it
 * @returns {string|null} the geo id, or null when no entry is that place
 */
function idForSlug(answer, slug) {
  const wanted = slug.toLowerCase();
  const results = Array.isArray(answer?.results) ? answer.results : [];

  for (const entry of results) {
    const geoLocation = entry?.geoLocation;
    if (geoLocation == null) continue;
    const spellsSlug = urlNamesOf(geoLocation).some((name) => String(name).toLowerCase() === wanted);
    if (spellsSlug) {
      const id = geoLocation.id;
      return typeof id === 'string' && id.length > 0 ? id : null;
    }
  }
  return null;
}

/**
 * Ask the autocomplete for one name.
 *
 * @param {string} endpoint the portal's own `/geo/locations`
 * @param {string} name the place name to ask for
 * @param {string} lang the language of the ask, which decides the spelling of the answer
 * @returns {Promise<any|null>} the parsed answer, or null when it did not arrive
 */
async function askLocations(endpoint, name, lang) {
  const url = new URL(endpoint);
  url.searchParams.set('lang', lang);
  url.searchParams.set('name', name);

  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    logger.error(`Error fetching the locations from ${url.host}: ${response.status} ${response.statusText}`);
    return null;
  }
  return response.json().catch(() => null);
}

/**
 * Resolve the location slug of a pasted search URL into the geo id the search query wants.
 *
 * The language matters: the autocomplete answers a name in the language it is asked in, so
 * `nazione-germania` resolves only when the ask carries `lang=it`. The caller knows the language
 * from the URL, and this module does not guess one.
 *
 * A slug that resolves nothing is a failed lookup, not a search: the caller fails the read.
 *
 * @param {{endpoint: string, slug: string, lang: string}} location the portal's endpoint, the slug
 *   the URL wrote and the URL's language
 * @returns {Promise<string|null>} the geo id, or null when the slug resolved nothing
 */
export async function resolveGeoLocationId({ endpoint, slug, lang }) {
  for (const name of candidateNames(slug)) {
    const answer = await askLocations(endpoint, name, lang);
    if (answer == null) return null;

    const id = idForSlug(answer, slug);
    if (id != null) return id;
  }

  logger.warn(`The location endpoint knows no place named "${slug}". The search URL may be wrong.`);
  return null;
}
