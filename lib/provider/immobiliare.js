/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Immobiliare.it, Italy's largest property portal.
 *
 * The portal answers a search in one of two shapes, and this provider reads both.
 *
 * A town search ("/vendita-case/milano/") is a Next.js page that server renders the whole result
 * set into `__NEXT_DATA__`, so the results are read out of that payload rather than out of the
 * cards. The page is behind DataDome, which the shared browser clears from a residential
 * connection but not from a datacenter one, so a walled render falls through to the service
 * `FREDY_CHALLENGE_SOLVER_URL` names.
 *
 * A map search ("/search-list/?vrt=...") renders in the browser instead, and its markup carries no
 * results at all. Those come from `search-list/listings`, the endpoint the page calls once it is
 * running - which needs neither browser nor solver, because DataDome guards the pages and not it.
 *
 * Both shapes end in the same payload, so one `normalize` reads either.
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import { readNextData } from '../utils/priceExtractors.js';
import puppeteerExtractor from '../services/extractor/puppeteerExtractor.js';
import { solveChallenge } from '../services/extractor/challengeSolver.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.immobiliare.it/';

/** The react-query entry the search results live under, both in the page and at the endpoint. */
const LIST_QUERY_KEY = 'real-estate-list';

/** The map search, whose results never reach the markup. */
const MAP_SEARCH_PATH = '/search-list/';

/** The endpoint that map search calls for its results. */
const LISTINGS_ENDPOINT_PATH = '/api-next/search-list/listings/';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Read the search results out of a rendered search page.
 *
 * @param {string|null|undefined} html the raw html of a search result page
 * @returns {any[]|null} the raw results, or null when the page carried no payload
 */
export function parseListings(html) {
  const queries = readNextData(html)?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return null;

  const query = queries.find((entry) => Array.isArray(entry?.queryKey) && entry.queryKey[0] === LIST_QUERY_KEY);
  const results = query?.state?.data?.results;
  return Array.isArray(results) ? results : null;
}

/**
 * Translate a map search url into the call that page makes for its results.
 *
 * The endpoint reads the search out of the query, which a map search already carries in full, and
 * wants the page it was called from as well - `path`, without which it answers 500.
 *
 * @param {string} url a map search url
 * @returns {string} the endpoint url to request
 */
export function convertMapSearchToApi(url) {
  const parsed = new URL(url);
  const endpoint = new URL(LISTINGS_ENDPOINT_PATH, BASE_URL);
  endpoint.search = parsed.search;
  endpoint.searchParams.set('path', parsed.pathname);
  return endpoint.toString();
}

/**
 * @param {string} url a map search url
 * @returns {Promise<any[]>} the raw results of the requested page
 */
async function getListingsFromApi(url) {
  const response = await fetch(convertMapSearchToApi(url), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      Referer: BASE_URL,
    },
  });

  if (!response.ok) {
    logger.error(`Immobiliare.it answered ${response.status} ${response.statusText}. The search URL may be wrong.`);
    return [];
  }

  const results = (await response.json())?.results;
  if (!Array.isArray(results)) {
    logger.error('Immobiliare.it returned a payload without search results. The search URL may be wrong.');
    return [];
  }
  return results;
}

/**
 * @param {string} url a town search url
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of the first page
 */
async function getListingsFromPage(url, browser) {
  const rendered = await puppeteerExtractor(url, 'body', { browser, name: 'immobiliare' });
  const results = parseListings(rendered) ?? parseListings((await solveChallenge(url, 'Immobiliare.it'))?.html);
  if (results == null) {
    logger.error('Immobiliare.it returned a page without search results. The search URL may be wrong.');
    return [];
  }
  return results;
}

/**
 * @param {string} url the search url, with the sort parameter already appended
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of the first page
 */
async function getListings(url, browser) {
  return new URL(url).pathname === MAP_SEARCH_PATH ? getListingsFromApi(url) : getListingsFromPage(url, browser);
}

/**
 * The unit an advert is filtered and priced by.
 *
 * A new development is published as one advert holding one entry per unit on offer, all of them
 * with their own surface, rooms and price. Fredy stores one listing per advert, so the flagged main
 * unit is the one it reports, and the first entry stands in where nothing is flagged.
 *
 * @param {any} realEstate one entry's `realEstate` object
 * @returns {any} the unit to read the figures off, never null
 */
function mainProperty(realEstate) {
  const properties = Array.isArray(realEstate?.properties) ? realEstate.properties : [];
  return properties.find((property) => property?.isMain) ?? properties[0] ?? {};
}

/**
 * Build the address shown on the listing.
 *
 * Immobiliare publishes the street on its own and the town in a separate field, so neither half is
 * usable alone: "Via Giulia" is a street in half the country. The macrozone (Rome's "Centro
 * Storico") is left out because it duplicates what the title already says and Nominatim resolves
 * the pair without it - and the coordinates come with the advert anyway, so this text is what a
 * reader sees rather than what the geocoder works from.
 *
 * @param {any} location one unit's `location` object
 * @returns {string|null} the address, or null when the advert names no place at all
 */
function buildAddress(location) {
  const parts = [location?.address, location?.city ?? location?.macrozone].filter(
    (part) => typeof part === 'string' && part.trim().length > 0,
  );
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * @param {any} o one entry of the search payload
 * @returns {ParsedListing}
 */
function normalize(o) {
  const realEstate = o?.realEstate ?? {};
  const property = mainProperty(realEstate);
  // An advert whose owner asked for the price to stay hidden carries the label but no figure.
  const price = realEstate.price?.visible === false ? null : realEstate.price?.value;
  const location = property.location ?? {};

  return {
    id: buildHash(String(realEstate.id ?? ''), price == null ? null : String(price)),
    title: realEstate.title ?? o?.seo?.anchor,
    link: o?.seo?.url,
    price: extractNumber(price),
    // "50 m²" on a flat, "1.200 m²" on a plot - both are display strings, never numbers.
    size: extractNumber(property.surface),
    // The upper open band is written "5+", which is five rooms and then some.
    rooms: extractNumber(property.rooms),
    address: buildAddress(location),
    latitude: location.latitude,
    longitude: location.longitude,
    description: property.description,
    image: property.photo?.urls?.large ?? property.photo?.urls?.medium ?? property.photo?.urls?.small,
  };
}

/**
 * @param {ParsedListing} o
 * @param {string[]} appliedBlackList Terms the job wants filtered out.
 * @returns {boolean}
 */
function applyBlacklist(o, appliedBlackList) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  return o.title != null && titleNotBlacklisted && descNotBlacklisted;
}

/** @type {ProviderConfig} */
const config = {
  url: null,
  requiredFieldNames: ['id', 'title', 'link', 'price', 'size', 'rooms', 'address'],
  // The results come from a json payload rather than from the markup, so there is nothing to crawl.
  crawlContainer: null,
  crawlFields: {},
  // `criterio=data` is the advert's own publication date. `dataModifica`, which the portal used to
  // sort by and still accepts, is ignored by the search backend and silently falls back to
  // relevance - which puts the paid placements first and a week-old advert above this morning's.
  sortByDateParam: 'criterio=data&ordine=desc',
  getListings,
  normalize,
  activityProbe: checkIfListingIsActive,
};

export const metaInformation = {
  countries: ['it'],
  name: 'Immobiliare.it',
  baseUrl: BASE_URL,
  id: 'immobiliare',
};

/**
 * Build a run-scoped provider configuration.
 *
 * @param {{url: string, enabled?: boolean}} sourceConfig The job's entry for this provider.
 * @param {string[]} [blacklist] Terms to filter listings out by.
 * @returns {ProviderConfig} A configuration usable by a single pipeline run.
 */
export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url,
  filter: (listing) => applyBlacklist(listing, blacklist ?? []),
});

export { config };
