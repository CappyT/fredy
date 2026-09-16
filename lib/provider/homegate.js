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
 * 1. `GET /geo/locations?lang=…&name=…` is unprotected and turns the location slug of the pasted
 *    URL into the geo tag the search query wants. The answer names each place with a `urlNames`
 *    block, and only the entry whose block spells the whole slug is that URL's place. The lookup is
 *    shared with ImmoScout24.ch, which runs the same SMG code, in `lib/services/smg/geoLocations.js`.
 * 2. `POST /search/listings` runs the search. It answers 403 with a DataDome challenge until the
 *    request carries a `datadome` cookie, which `lib/services/datadome.js` solves and keeps.
 *
 * `POST /search/listings-by-url`, the endpoint the app uses for a pasted URL, is not usable: it
 * answered 422 "not a SRP uri" for eight public `www.homegate.ch` URL forms. The pasted URL is
 * therefore translated into the structured query here.
 *
 * The OTP signature headers (`X-App-Id`, `X-App-Time`) are not needed once the cookie is valid, so
 * none of that is reproduced. The app's own user agent is sent: a desktop one earns a `bv`
 * challenge this portal never lets through.
 */

import { buildHash, isOneOf } from '../utils.js';
import { publicationDate } from '../utils/publicationDate.js';
import { isDataDomeBlock, readToken, tokenForBlock, SOLVE_USER_AGENT } from '../services/datadome.js';
import { resolveGeoLocationId } from '../services/smg/geoLocations.js';
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
 * The user agent every search request is made with: the app's own.
 *
 * The host is the mobile API, and DataDome answers a desktop user agent with a `bv` challenge. That
 * value means the asking IP is blocked, and no cookie solves that. The app user agent earns the
 * `fe` challenge capsolver can solve, so the search carries it.
 *
 * `SOLVE_USER_AGENT` is still handed to `tokenForBlock`, because capsolver accepts only the fixed
 * set of user agents it ships. The cookie is not bound to the user agent that earned it: the
 * recorded solve replayed across two user agents and two IPs, so a cookie minted under one agent is
 * accepted on a request that carries the other.
 */
const APP_USER_AGENT = 'homegate.ch.nextgen App Android/13.3.0';

const REQUEST_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'de-CH,de;q=0.9',
  'User-Agent': APP_USER_AGENT,
};

/** The language prefix a URL may carry, which says nothing about the search. */
const LOCALES = new Set(['de', 'fr', 'it', 'en']);

/**
 * How the URL spells the offer type, and the language that word is written in.
 *
 * Homegate serves its four languages under one path shape with no language prefix, so the offer
 * type word is the only signal of the language the URL was written in. The location lookup needs
 * that language: the autocomplete answers a name in the language it is asked in.
 */
const OFFER_TYPES = {
  rent: { offerType: 'RENT', lang: 'en' },
  mieten: { offerType: 'RENT', lang: 'de' },
  louer: { offerType: 'RENT', lang: 'fr' },
  affittare: { offerType: 'RENT', lang: 'it' },
  buy: { offerType: 'BUY', lang: 'en' },
  kaufen: { offerType: 'BUY', lang: 'de' },
  acheter: { offerType: 'BUY', lang: 'fr' },
  acquistare: { offerType: 'BUY', lang: 'it' },
};

/**
 * The property type a URL segment names, in each of the four languages.
 *
 * Only the four types the query accepts are mapped. A segment this does not name leaves the
 * property type absent, which widens the search a little; a guessed enum would narrow it to the
 * wrong type in silence.
 */
const PROPERTY_TYPES = {
  apartment: 'APARTMENT',
  wohnung: 'APARTMENT',
  appartement: 'APARTMENT',
  appartamento: 'APARTMENT',
  house: 'HOUSE_OR_CHALET_OR_RUSTICO',
  haus: 'HOUSE_OR_CHALET_OR_RUSTICO',
  maison: 'HOUSE_OR_CHALET_OR_RUSTICO',
  casa: 'HOUSE_OR_CHALET_OR_RUSTICO',
  plot: 'BUILDING_PLOT',
  bauland: 'BUILDING_PLOT',
  terrain: 'BUILDING_PLOT',
  terreno: 'BUILDING_PLOT',
  'parking-place-garage': 'PARKING_SPACE_OR_GARAGE',
  'parkplatz-garage': 'PARKING_SPACE_OR_GARAGE',
  'place-de-parc-garage': 'PARKING_SPACE_OR_GARAGE',
  'parcheggio-garage': 'PARKING_SPACE_OR_GARAGE',
};

/**
 * The segments that name the portal's "everything" category, in each of the four languages.
 *
 * They name no property type and no place, so neither is read out of one. A URL that carries one
 * searches every type, which is what the category itself means.
 */
const CATEGORY_SEGMENTS = new Set(['real-estate', 'immobilien', 'biens-immobiliers', 'immobile']);

/** The trailing segment of a search result page, which names no place either. */
const SRP_SEGMENTS = new Set(['matching-list', 'trefferliste', 'liste-annonces', 'lista-annunci']);

/** A URL an image can be read from, which is how an attachment is told from a document. */
const IMAGE_URL = /\.(jpe?g|png|gif|webp|avif)(\?|$)/i;

/**
 * The parts of a pasted search URL the structured query is built from.
 *
 * @typedef {Object} HomegateSearch
 * @property {'RENT'|'BUY'} offerType
 * @property {'de'|'fr'|'it'|'en'} lang the language the offer type word is written in
 * @property {string|null} propertyType
 * @property {string|null} locationSlug the slug as the URL wrote it (`luogo-chiasso`), or null
 *   when the path names no place and the search therefore covers the whole country
 */

/**
 * Read a pasted search URL into the search the API accepts.
 *
 * The path is `/{offerType}/{category}/{location}[/{srp}]` -
 * `https://www.homegate.ch/rent/real-estate/city-zurich/matching-list` - with any number of filter
 * parameters behind it. The segments are classified one by one rather than read by their position:
 * the offer type, the property type, the "everything" category and the trailing result page segment
 * are each known words, and the place is the last segment left over.
 *
 * The last leftover segment is taken rather than the first, because the path can carry a property
 * word this does not map. `/rent/office/city-zurich/matching-list` is a real Homegate URL, and
 * `office` stands before the place; reading the first leftover would take `office` for the place and
 * never resolve the town.
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

  const segments = parsed.pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

  const offer = segments.map((segment) => OFFER_TYPES[segment]).find((entry) => entry != null) ?? null;
  if (offer == null) return null;

  const propertyType = segments.map((segment) => PROPERTY_TYPES[segment]).find((type) => type != null) ?? null;

  const locationSlug =
    segments.findLast(
      (segment) =>
        OFFER_TYPES[segment] == null &&
        PROPERTY_TYPES[segment] == null &&
        !LOCALES.has(segment) &&
        !CATEGORY_SEGMENTS.has(segment) &&
        !SRP_SEGMENTS.has(segment),
    ) ?? null;

  return { offerType: offer.offerType, lang: offer.lang, propertyType, locationSlug };
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

  // A path that names no place is the portal's own country-wide search, so it is read as one. A
  // path that does name a place and cannot resolve it is a different case: searching on without
  // the place would quietly answer the whole country for a job that asked for one town.
  const query = { offerType: search.offerType };
  if (search.locationSlug != null) {
    const geoTag = await resolveGeoLocationId({
      endpoint: LOCATIONS_ENDPOINT,
      slug: search.locationSlug,
      lang: search.lang,
    });
    if (geoTag == null) return [];
    query.location = { geoTags: [geoTag] };
  }
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

export { config, parseSearchUrl };
