/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Idealista.it, the Italian arm of the Spanish portal.
 *
 * A search is read through the mobile api the android app talks to, which serves JSON to a plain
 * request: no bot wall, no browser, no challenge solver, and an ordering by publication date that
 * the website's robots.txt refuses. The job still holds the search url a user copied out of their
 * browser, so `lib/services/idealista/` translates that url into the terms the api searches by.
 *
 * Not every url can be translated - a filter the api has no name for, a category it does not
 * serve - and those searches are read off the website instead, the slow way, behind the solver.
 * See `lib/services/idealista/search-filters.js` for what carries over and what does not.
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import { searchListings } from '../services/idealista/search.js';
import { pageUrl, parseListings, readSearch } from '../services/idealista/website.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.idealista.it';

export { pageUrl, parseListings };

/**
 * Split the address off a card title.
 *
 * A title reads "<type> in <street>, <district>, <town>", and "<type> a <district>, <town>" when
 * the advert names no street. "in" is looked for first because a type can itself contain "a"
 * ("casa a schiera"), which taking the earlier separator would cut in half.
 *
 * @param {string|undefined} title
 * @returns {string|null}
 */
function readAddress(title) {
  if (typeof title !== 'string') return null;
  const separator = title.includes(' in ') ? ' in ' : ' a ';
  const index = title.indexOf(separator);
  if (index < 0) return null;
  return title.slice(index + separator.length).trim() || null;
}

/**
 * @param {string[]} characteristics
 * @param {RegExp} pattern
 * @returns {number|null}
 */
function readCharacteristic(characteristics, pattern) {
  const match = characteristics.map((entry) => entry.match(pattern)).find(Boolean);
  return match == null ? null : extractNumber(match[1]);
}

/**
 * Read a card scraped off a result page.
 *
 * @param {any} o one card of the search page
 * @returns {ParsedListing}
 */
function normalizeCard(o) {
  const price = extractNumber(o?.price);
  const characteristics = Array.isArray(o?.characteristics) ? o.characteristics : [];

  return {
    id: buildHash(String(o?.id ?? ''), price == null ? null : String(price)),
    title: o?.title,
    link: o?.href == null ? null : `${BASE_URL}${o.href}`,
    price,
    size: readCharacteristic(characteristics, /^([\d.,]+)\s*m²/),
    rooms: readCharacteristic(characteristics, /^(\d+)\s+local/i),
    address: readAddress(o?.title),
    description: o?.description,
    image: o?.image,
  };
}

/**
 * A figure the api gives, or null where it gives none.
 *
 * The api writes a missing figure as zero rather than leaving the field out - a price on request, a
 * garage nobody counted rooms for - and a zero read as a figure would be a free flat of no size.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function figure(value) {
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * Read an advert the api answered with.
 *
 * The title is the api's `address`, which is the very line the website prints on a card
 * ("Bilocale in Via Tito Vignoli s.n.c, Lorenteggio, Milano"), so an advert read either way is
 * stored under the same hash and described in the same words.
 *
 * @param {any} o one advert of the api's answer
 * @returns {ParsedListing}
 */
function normalizeAdvert(o) {
  const price = typeof o?.price === 'number' ? figure(o.price) : extractNumber(o?.price);
  const title = typeof o?.address === 'string' ? o.address : null;

  return {
    id: buildHash(String(o?.propertyCode ?? ''), price == null ? null : String(price)),
    title,
    link: o?.url ?? null,
    price,
    size: figure(o?.size),
    rooms: figure(o?.rooms),
    address: readAddress(title ?? undefined),
    description: o?.description,
    image: o?.thumbnail,
    // The api gives every advert a point, which spares the geocoder a lookup. An advert that hides
    // its address is placed at the middle of its neighbourhood rather than at its door.
    latitude: typeof o?.latitude === 'number' ? o.latitude : undefined,
    longitude: typeof o?.longitude === 'number' ? o.longitude : undefined,
  };
}

/**
 * @param {any} o one advert, from either source
 * @returns {ParsedListing}
 */
function normalize(o) {
  return o?.propertyCode == null ? normalizeCard(o) : normalizeAdvert(o);
}

/**
 * Read the adverts of a search, through the api where the url can be translated into it.
 *
 * A failing api is treated as an untranslatable url: the website still holds the search, and a run
 * that reads it is better than a run that finds nothing.
 *
 * @param {string} url the job's search url
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  try {
    const found = await searchListings(url);
    if (found != null) return found;
  } catch (error) {
    logger.error(`Idealista's api did not answer (${error.message}); reading the website instead.`);
  }
  return readSearch(url);
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
  // The adverts are read by `getListings`, from the api or from the cards, so the generic crawler
  // has no work.
  crawlContainer: null,
  crawlFields: {},
  // The api sorts by publication date itself, and the website disallows that sort in its
  // robots.txt, so there is no ordering to ask for in the url either way.
  getListings,
  normalize,
  activityProbe: checkIfListingIsActive,
};

export const metaInformation = {
  countries: ['it'],
  name: 'Idealista',
  baseUrl: `${BASE_URL}/`,
  id: 'idealista',
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
