/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Immobiliare.it, Italy's largest property portal.
 *
 * The search page is a Next.js application that server renders the whole result set into
 * `__NEXT_DATA__`, so the results are read out of that payload rather than out of the cards. The
 * payload carries the figures as numbers, the coordinates to four decimals and the description, and
 * none of the three survive into the markup.
 *
 * The page goes through the shared browser rather than through `fetch`. Immobiliare.it sits behind
 * DataDome, which answers a plain request with a 403 interstitial after the first few, and the
 * browser is the only client here that holds the cookie that wall wants.
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import { readNextData } from '../utils/priceExtractors.js';
import puppeteerExtractor from '../services/extractor/puppeteerExtractor.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.immobiliare.it/';

/** The react-query entry the search results live under. */
const LIST_QUERY_KEY = 'real-estate-list';

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
 * @param {string} url the search url, with the sort parameter already appended
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of the first page
 */
async function getListings(url, browser) {
  const html = await puppeteerExtractor(url, 'body', { browser, name: 'immobiliare' });
  const results = parseListings(html);
  if (results == null) {
    logger.error('Immobiliare.it returned a page without search results. The search URL may be wrong.');
    return [];
  }
  return results;
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
  // The results come from __NEXT_DATA__ rather than from the markup, so there is nothing to crawl.
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
