/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Casa.it, one of the three national portals Italian agencies publish to.
 *
 * The search page is a server rendered React application that hands its store to the browser as
 * `window.__INITIAL_STATE__`, and the results are read out of that store rather than out of the
 * cards: it carries the price as a number, the surface, the rooms and the coordinates, none of
 * which survive into the markup in a form worth parsing.
 *
 * The portal answers a search in one of two shapes and this provider reads both. A town search
 * ("/affitto/residenziale/roma/") fills the store's `search`; a map search ("/srp/map/?geopolygon=...")
 * leaves that half empty and fills `searchMap` instead. The entries are the same either way, so one
 * `normalize` reads both.
 *
 * The page goes through the shared browser rather than through `fetch`. Casa.it sits behind
 * DataDome, which answers a plain request with a 403 interstitial, and the browser is the only
 * client here that gets past it.
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import { sanitize } from '../utils/priceExtractors.js';
import puppeteerExtractor from '../services/extractor/puppeteerExtractor.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.casa.it';

/** Where casa.it serves the photos its listings name by path. */
const IMAGE_CDN = 'https://images-1.casa.it';

/**
 * The store is not embedded as JSON but as `JSON.parse("…")` around a JavaScript string literal,
 * so the payload arrives escaped twice. A JSON string literal is itself valid JSON, which is what
 * lets the outer layer be peeled off with the same parser rather than with an unescaper of our own.
 */
const INITIAL_STATE = /window\.__INITIAL_STATE__\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/;

/**
 * Read the search results out of a rendered search page.
 *
 * @param {string|null|undefined} html the raw html of a search result page
 * @returns {any[]|null} the raw results, or null when the page carried no store
 */
export function parseListings(html) {
  const match = html?.match(INITIAL_STATE);
  if (match == null) return null;

  try {
    const state = JSON.parse(JSON.parse(match[1]));
    // A map search leaves `search` empty and fills `searchMap` with the same entries.
    const list = state?.search?.list ?? state?.searchMap?.list;
    return Array.isArray(list) ? list : null;
  } catch (error) {
    logger.error('Could not parse the casa.it store.', error?.message || error);
    return null;
  }
}

/**
 * @param {string} url the search url, with the sort parameter already appended
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of the first page
 */
async function getListings(url, browser) {
  const html = await puppeteerExtractor(url, 'body', { browser, name: 'casa' });
  const listings = parseListings(html);
  if (listings == null) {
    logger.error('Casa.it returned a page without search results. The search URL may be wrong.');
    return [];
  }
  return listings;
}

/**
 * Read a listing's price.
 *
 * The store carries the same figure twice: as a number on the map marker and as the display string
 * the card shows. The number is taken, because "1.900" read as a decimal is one euro ninety. A
 * development quoting a range reports its lower bound, which is the figure the card leads with.
 *
 * @param {any} price the `features.price` object
 * @returns {number|null} the price, or null when the advert keeps it off the site
 */
function readPrice(price) {
  if (price == null || price.show === false) return null;
  return sanitize(price.marker?.originalPrice) ?? extractNumber(price.min ?? price.value);
}

/**
 * Build the address shown on the listing.
 *
 * The street is only published when the agency allows it - `show_address` - and the district is
 * what is left when it does not. Either way the town has to follow, because a street name alone is
 * a street in half the country.
 *
 * @param {any} geoInfos the listing's `geoInfos` object
 * @returns {string|null} the address, or null when the listing names no place at all
 */
function buildAddress(geoInfos) {
  const place = geoInfos?.street || geoInfos?.district_name || geoInfos?.block_name;
  const parts = [place, geoInfos?.city].filter((part) => typeof part === 'string' && part.trim().length > 0);
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * @param {any} o one entry of the search store
 * @returns {ParsedListing}
 */
function normalize(o) {
  const features = o?.features ?? {};
  const geoInfos = o?.geoInfos ?? {};
  const price = readPrice(features.price);
  const photo = o?.media?.items?.[0]?.uri;

  return {
    id: buildHash(String(o?.id ?? ''), price == null ? null : String(price)),
    title: o?.title?.main,
    link: o?.uri == null ? null : `${BASE_URL}${o.uri}`,
    price,
    // Already numbers in the store, unlike every display string the html scrapers read.
    size: sanitize(features.mq),
    rooms: sanitize(features.rooms),
    address: buildAddress(geoInfos),
    latitude: geoInfos.lat,
    longitude: geoInfos.lon,
    description: o?.description,
    image: photo == null ? null : `${IMAGE_CDN}${photo}`,
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
  // The results come from the store rather than from the markup, so there is nothing to crawl.
  crawlContainer: null,
  crawlFields: {},
  // Casa.it names its criteria `<field>_<direction>` and falls back to relevance for anything it
  // does not know, silently - `date` and `data_desc` both come back in the default order.
  sortByDateParam: 'sortType=date_desc',
  getListings,
  normalize,
  activityProbe: checkIfListingIsActive,
};

export const metaInformation = {
  countries: ['it'],
  name: 'Casa.it',
  baseUrl: `${BASE_URL}/`,
  id: 'casa',
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
