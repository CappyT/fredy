/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Homegate, the largest Swiss real estate portal, read through the mobile API its own app talks to.
 *
 * The website sits behind DataDome and refuses a plain client, so this reads `api.homegate.ch`
 * instead. Two endpoints are enough:
 *
 * 1. `GET /geo/locations?lang=de&name=…` is unprotected and turns the location slug of the pasted
 *    URL into the geo tag the search query wants (`city-zurich` into `geo-city-zurich`).
 * 2. `POST /search/listings` runs the search. It answers 403 with a DataDome challenge until the
 *    request carries a `datadome` cookie, which `lib/services/datadome.js` solves and keeps.
 *
 * `POST /search/listings-by-url`, the endpoint the app uses for a pasted URL, is not usable: it
 * answered 422 "not a SRP uri" for eight public `www.homegate.ch` URL forms. The pasted URL is
 * therefore translated into the structured query here.
 *
 * The OTP signature headers (`X-App-Id`, `X-App-Time`) and the app user agent are not needed once
 * the cookie is valid, so none of that is reproduced.
 */

import { buildHash, isOneOf } from '../utils.js';
import { publicationDate } from '../utils/publicationDate.js';
import { isDataDomeBlock, readToken, tokenForBlock, SOLVE_USER_AGENT } from '../services/datadome.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.homegate.ch/';
const API_HOST = 'api.homegate.ch';
const SEARCH_ENDPOINT = `https://${API_HOST}/search/listings`;
const LOCATIONS_ENDPOINT = `https://${API_HOST}/geo/locations`;

/**
 * How many listings one page holds, and how many pages one run reads.
 *
 * The app pages with `from = (page - 1) * 20` and `size = 20`; five pages are a hundred listings,
 * the order of magnitude Flatfox reads. A job only ever cares about the newest handful, and the
 * portal counts its searches in hundreds, so reading further buys nothing worth the requests.
 */
const PAGE_SIZE = 20;
const MAX_PAGES = 5;

/**
 * The user agent every request is made with.
 *
 * Capsolver answers only the fixed set of user agents it ships, and DataDome binds the cookie to
 * the one it was earned with, so the search has to be made with the very agent the token was
 * solved under.
 */
const REQUEST_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'de-CH,de;q=0.9',
  'User-Agent': SOLVE_USER_AGENT,
};

/** The language prefix a URL may carry, which says nothing about the search. */
const LOCALES = new Set(['de', 'fr', 'it', 'en']);

/** How the URL spells the offer type. */
const OFFER_TYPES = { rent: 'RENT', buy: 'BUY' };

/**
 * The category segment of the URL as the query's `propertyType`.
 *
 * `real-estate-listings` is the portal's "everything" segment and names no type, so it is absent
 * here on purpose. The mapping is read from the segments the URLs are known to carry; a segment
 * this does not name is not translated at all rather than guessed at.
 */
const PROPERTY_TYPES = {
  apartment: 'APARTMENT',
  house: 'HOUSE_OR_CHALET_OR_RUSTICO',
  'building-plot': 'BUILDING_PLOT',
  'parking-space': 'PARKING_SPACE_OR_GARAGE',
};

/** A location slug as the URL writes it: a type, a hyphen, and the place. */
const LOCATION_SLUG = /^([a-z]+)-(.+)$/;

/** A geo tag as the location endpoint and the listing response write it (`geo-city-zurich`). */
const GEO_TAG = /^geo-[a-z0-9-]+$/i;

/** A URL an image can be read from, which is how an attachment is told from a document. */
const IMAGE_URL = /\.(jpe?g|png|gif|webp|avif)(\?|$)/i;

/**
 * The parts of a pasted search URL the structured query is built from.
 *
 * @typedef {Object} HomegateSearch
 * @property {'RENT'|'BUY'} offerType
 * @property {string|null} propertyType
 * @property {string} locationSlug the slug as the URL wrote it (`city-zurich`)
 * @property {string} locationName the same slug as words, which is what the autocomplete wants
 */

/**
 * Read a pasted search URL into the search the API accepts.
 *
 * The path is `/{offerType}/{category}/{location}` - `https://www.homegate.ch/rent/real-estate-listings/city-zurich`
 * - with an optional language prefix in front and any number of filter parameters behind.
 *
 * The query string is deliberately not translated: nothing in the notes names a parameter of it,
 * and a filter written under a guessed name would silently change the search rather than fail it.
 * The price range the job configured is not read out of the URL either, for the same reason.
 *
 * @param {string} url The job's search URL.
 * @returns {HomegateSearch|null} The search, or null when the URL states nothing this can read.
 */
function parseSearchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (LOCALES.has(segments[0]?.toLowerCase())) segments.shift();

  const offerType = OFFER_TYPES[segments.shift()?.toLowerCase()];
  if (offerType == null) return null;

  const location = LOCATION_SLUG.exec(segments.pop() ?? '');
  if (location == null) return null;

  const propertyType =
    segments.map((segment) => PROPERTY_TYPES[segment.toLowerCase()]).find((type) => type != null) ?? null;

  return {
    offerType,
    propertyType,
    locationSlug: location[0].toLowerCase(),
    locationName: location[2].replace(/-/g, ' '),
  };
}

/**
 * Every string of a response that reads as a geo tag.
 *
 * The response model of the location endpoint is not documented - only that `geo-city-zurich` came
 * out of it when `Zuerich` was asked for - so the tag is looked for wherever it sits in the answer
 * rather than read off a field name that would have to be guessed.
 *
 * @param {any} value
 * @param {string[]} [found]
 * @returns {string[]}
 */
function geoTagsIn(value, found = []) {
  if (typeof value === 'string') {
    if (GEO_TAG.test(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) geoTagsIn(entry, found);
  } else if (value != null && typeof value === 'object') {
    for (const entry of Object.values(value)) geoTagsIn(entry, found);
  }
  return found;
}

/**
 * @param {string} url
 * @param {string} what Named in the log line when the request fails.
 * @returns {Promise<any|null>}
 */
async function getJson(url, what) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    logger.error(`Error fetching ${what} from Homegate: ${response.status} ${response.statusText}`);
    return null;
  }
  return response.json();
}

/**
 * The geo tag of the location a URL names.
 *
 * The tag is taken from the endpoint rather than built out of the slug, because the endpoint is
 * what says which places exist under that name. An answer without the slug's own tag resolves
 * nothing: the autocomplete answers dozens of neighbouring places, and taking one of them would
 * search a different town in silence.
 *
 * @param {HomegateSearch} search
 * @returns {Promise<string|null>}
 */
async function resolveGeoTag(search) {
  const answer = await getJson(
    `${LOCATIONS_ENDPOINT}?lang=de&name=${encodeURIComponent(search.locationName)}`,
    'the locations',
  );
  if (answer == null) return null;

  const wanted = `geo-${search.locationSlug}`;
  const tag = geoTagsIn(answer).find((candidate) => candidate.toLowerCase() === wanted);
  if (tag == null) {
    logger.warn(`Homegate knows no location "${search.locationSlug}". The search URL may be wrong.`);
    return null;
  }
  return tag;
}

/**
 * Ask the search endpoint for one page.
 *
 * DataDome refuses the endpoint without a `datadome` cookie and names the challenge it wants
 * solved. `tokenForBlock` answers a cookie only when the deployment is configured to solve one, so
 * an unconfigured run keeps the old behaviour and reads the refusal below.
 *
 * @param {Object} body The request body.
 * @returns {Promise<any|null>} The page, or null when it did not arrive.
 */
async function requestPage(body) {
  const token = readToken(API_HOST);

  /** @param {string|null} cookie */
  const send = (cookie) => {
    const headers = { ...REQUEST_HEADERS, 'Content-Type': 'application/json' };
    if (cookie != null) headers.Cookie = cookie;
    return fetch(SEARCH_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
  };

  let response = await send(token);

  // Only a 403 can be DataDome, and only its body says whether it is: the read is kept off every
  // successful answer, whose body is read as json below.
  if (response.status === 403) {
    const blocked = await response.text().catch(() => '');
    if (isDataDomeBlock(response.status, blocked)) {
      const solved = await tokenForBlock({
        status: response.status,
        body: blocked,
        host: API_HOST,
        userAgent: SOLVE_USER_AGENT,
        usedToken: token,
      });
      if (solved == null) {
        logger.error('Homegate refused the search with a DataDome challenge that could not be solved.');
        return null;
      }
      response = await send(solved);
    }
  }

  if (!response.ok) {
    // The endpoint names what it refused, and that body is the only place the reason appears.
    const refused = await response.text().catch(() => '');
    logger.error(`Homegate answered ${response.status} ${response.statusText}: ${refused.slice(0, 300)}`.trimEnd());
    return null;
  }

  try {
    return await response.json();
  } catch {
    logger.error('Homegate answered 200 with something that is not the search payload.');
    return null;
  }
}

/**
 * @param {string} url The job's search URL.
 * @returns {Promise<Object[]>} The raw listings of every page read.
 */
async function getListings(url) {
  const search = parseSearchUrl(url);
  if (search == null) {
    logger.error(`Could not read the Homegate search URL: ${url}`);
    return [];
  }

  const geoTag = await resolveGeoTag(search);
  if (geoTag == null) return [];

  const query = { offerType: search.offerType, location: { geoTags: [geoTag] } };
  if (search.propertyType != null) query.propertyType = search.propertyType;

  const listings = [];
  // The portal's own ceiling, read off the first answer. Infinite until then, so a response that
  // never states one does not end the walk.
  let maxFrom = Number.POSITIVE_INFINITY;
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const from = (page - 1) * PAGE_SIZE;
    if (from > maxFrom) break;

    const answer = await requestPage({
      query,
      sortBy: 'dateCreated',
      sortDirection: 'desc',
      from,
      size: PAGE_SIZE,
      trackTotalHits: true,
      fieldset: 'srp-list',
    });
    if (answer == null) break;

    const found = Array.isArray(answer.results) ? answer.results : [];
    listings.push(...found);
    if (Number.isFinite(Number(answer.maxFrom))) maxFrom = Number(answer.maxFrom);
    if (found.length === 0) break;
  }

  // A walk that ended on the page cap rather than on the portal's ceiling read less than the
  // search matched, which is worth a line.
  if (page > MAX_PAGES && maxFrom >= MAX_PAGES * PAGE_SIZE) {
    logger.warn(`Homegate: stopped after ${MAX_PAGES} pages. Narrow the search to see the rest.`);
  }

  return listings;
}

/**
 * Read one of the API's numbers.
 *
 * Deliberately not `extractNumber`: that parser is built for the German-formatted text the scraping
 * providers pull off a page, where a dot groups thousands. The API answers JSON with English
 * decimals, so it would read `numberOfRooms: 2.5` as twenty-five rooms.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {unknown} part @returns {string} */
const clean = (part) => (part == null ? '' : String(part).trim());

/**
 * The address shown on the listing.
 *
 * The notes name only `geoCoordinates` and `geoTags` of this object, so the textual fields read
 * here are the names the shared SMG model is expected to use and were not verified against the
 * live response. A shape that carries none of them answers null, which costs the listing its
 * address rather than inventing one.
 *
 * @param {any} address The listing's `address` object.
 * @returns {string|null}
 */
function buildAddress(address) {
  const street = [address?.street, address?.houseNumber].map(clean).filter(Boolean).join(' ');
  const town = [address?.zip, address?.city].map(clean).filter(Boolean).join(' ');
  const parts = [street, town].filter(Boolean);
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * The language block the listing is described in.
 *
 * @param {any} listing
 * @returns {any}
 */
function primaryLocalization(listing) {
  const localization = listing?.localization ?? {};
  return (
    localization[localization.primary] ?? localization.de ?? localization.en ?? localization.fr ?? localization.it ?? {}
  );
}

/**
 * The first attachment that carries an image.
 *
 * The block holds documents as well - plans and brochures - so an entry whose URL is not an image
 * is not one.
 *
 * @param {any} block one language block
 * @returns {string|null}
 */
function firstImageUrl(block) {
  const attachments = Array.isArray(block?.attachments) ? block.attachments : [];
  return attachments.find((entry) => typeof entry?.url === 'string' && IMAGE_URL.test(entry.url))?.url ?? null;
}

/**
 * The listing's own page.
 *
 * The search response carries no URL for a listing, so the site's pattern is rebuilt from the id.
 * The pattern is not verified against the live portal: homegate.ch serves a listing under its id
 * below the offer type, and a wrong guess costs a broken link rather than a wrong listing, because
 * the row's identity is the hash above.
 *
 * @param {any} listing
 * @returns {string|null}
 */
function listingLink(listing) {
  if (listing?.id == null || String(listing.id).length === 0) return null;
  return `${BASE_URL}${listing.offerType ?? 'rent'}/${listing.id}`;
}

/**
 * @param {any} o One entry of the search response, a `SmgListing`.
 * @returns {ParsedListing}
 */
function normalize(o) {
  const listing = o?.listing ?? {};
  // Nettomiete first: `gross` is the Bruttomiete, Nebenkosten already included, and the
  // affordability check adds a Nebenkosten surcharge to whatever stands here. A rent that is a
  // quarter too pessimistic still beats a listing dropped for want of a price.
  const price =
    toNumber(listing.prices?.rent?.net) ??
    toNumber(listing.prices?.rent?.gross) ??
    toNumber(listing.prices?.buy?.price);
  const block = primaryLocalization(listing);

  return {
    id: buildHash(String(listing.id ?? ''), price == null ? null : String(price)),
    title: block?.text?.title ?? block?.text?.translatedTitle ?? null,
    link: listingLink(listing),
    price,
    size: toNumber(listing.characteristics?.livingSpace),
    rooms: toNumber(listing.characteristics?.numberOfRooms),
    address: buildAddress(listing.address),
    description: block?.text?.description ?? null,
    publishedAt: publicationDate(listing.meta?.createdAt),
    image: firstImageUrl(block),
  };
}

/**
 * @param {ParsedListing} o
 * @param {string[]} appliedBlackList
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
  crawlContainer: null,
  crawlFields: {},
  // The body carries the sort - `dateCreated` `desc`, newest first - so nothing is appended to the
  // URL.
  sortByDateParam: null,
  // No price filter of the portal is named in the notes, and a wrong parameter would report a
  // confidently wrong band on every observation. Absent means no range.
  priceRangeParams: null,
  getListings,
  normalize,
};

export const metaInformation = {
  countries: ['ch'],
  name: 'Homegate',
  baseUrl: BASE_URL,
  id: 'homegate',
};

/**
 * Build a run-scoped provider configuration.
 *
 * @param {{url: string, enabled?: boolean}} sourceConfig
 * @param {string[]} [blacklist]
 * @returns {ProviderConfig}
 */
export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url,
  filter: (listing) => applyBlacklist(listing, blacklist ?? []),
});

export { config };
