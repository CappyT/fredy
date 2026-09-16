/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * ImmoScout24.ch, the Swiss portal, read through the mobile API its own app talks to.
 *
 * The website sits behind DataDome, which refuses a plain client; the app's host answers the same
 * search over a JSON API as soon as the request carries a `datadome` cookie. That is the whole
 * transport, with no browser: the cookie is minted by `lib/services/datadome.js` when the
 * deployment configures capsolver and a proxy, and without them a refused read stays refused,
 * exactly as it does upstream.
 *
 * The user pastes a search URL. `POST /search/listings-by-url` would take it, but it was never
 * verified for this portal, and on the sister portal it answered 422 for every public web URL
 * form tried, so the URL is translated here into the structured query of `POST /search/listings`.
 *
 * Both apps are the same SMG code base, so the place of the pasted URL is resolved by the module
 * both Swiss providers share, `lib/services/smg/geoLocations.js`. The query DSL, the response model
 * and the field mapping are documented in `reverse-engineered-homegate.md`;
 * `reverse-engineered-immoscout24ch.md` holds this portal's own host and app values.
 */

import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { publicationDate } from '../utils/publicationDate.js';
import { readToken, tokenForBlock, SOLVE_USER_AGENT } from '../services/datadome.js';
import { resolveGeoLocationId } from '../services/smg/geoLocations.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.immoscout24.ch/';
const API_URL = 'https://api.immoscout24.ch';
const SEARCH_ENDPOINT = `${API_URL}/search/listings`;
const GEO_ENDPOINT = `${API_URL}/geo/locations`;
const HOST = new URL(SEARCH_ENDPOINT).host;

/**
 * The two numbers that bound the walk.
 *
 * The API pages twenty at a time, like the app. A job only ever cares about the newest handful:
 * the sort is `dateCreated desc`, so a hundred adverts reach well past the point where a run stops
 * finding anything new, and Flatfox reads a hundred for the same reason. The cap is also what
 * bounds the number of refused pages one run can pay a solve for.
 */
const PAGE_SIZE = 20;
const MAX_PAGES = 5;

/**
 * The request headers of every search call.
 *
 * The user agent is the app's own, because the host is the mobile API: DataDome answers a desktop
 * user agent with a `bv` challenge, which means the asking IP is blocked and no cookie solves it.
 * The app user agent earns the `fe` challenge capsolver can solve.
 *
 * `SOLVE_USER_AGENT` is still handed to `tokenForBlock`, because capsolver accepts only the fixed
 * set of user agents it ships. The cookie is not bound to the user agent that earned it: the
 * recorded solve replayed across two user agents and two IPs, so a cookie minted under one agent is
 * accepted on a request that carries the other.
 *
 * The app's `X-App-Id` and `X-App-Time` are deliberately absent - once the cookie is valid the
 * server accepts a request without them, which is what makes a server-side provider possible at all.
 */
const APP_USER_AGENT = 'immoscout24.ch.nextgen App Android/6.3.0';

const REQUEST_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': APP_USER_AGENT,
};

/** The four languages the portal serves. */
const LANGUAGES = new Set(['de', 'fr', 'it', 'en']);

/**
 * The offer type a URL path segment names, and the language that word is written in.
 *
 * The word is a language signal when the URL carries no `/xx/` prefix. `affittare` and
 * `acquistare` are the Italian words this portal writes; the API enum is the same on both Swiss
 * portals.
 */
const OFFER_TYPE_SEGMENTS = new Map([
  ['rent', { offerType: 'RENT', lang: 'en' }],
  ['mieten', { offerType: 'RENT', lang: 'de' }],
  ['louer', { offerType: 'RENT', lang: 'fr' }],
  ['affittare', { offerType: 'RENT', lang: 'it' }],
  ['buy', { offerType: 'BUY', lang: 'en' }],
  ['kaufen', { offerType: 'BUY', lang: 'de' }],
  ['acheter', { offerType: 'BUY', lang: 'fr' }],
  ['acquistare', { offerType: 'BUY', lang: 'it' }],
]);

/**
 * The property type a URL path segment names, in each of the four languages.
 *
 * Only the four types the query accepts are mapped. A segment this does not name leaves the
 * property type absent, which widens the search a little; a guessed enum would narrow it to the
 * wrong type in silence.
 */
const PROPERTY_TYPE_SEGMENTS = new Map([
  ['apartment', 'APARTMENT'],
  ['wohnung', 'APARTMENT'],
  ['appartement', 'APARTMENT'],
  ['appartamento', 'APARTMENT'],
  ['house', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['haus', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['maison', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['casa', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['plot', 'BUILDING_PLOT'],
  ['grundstueck', 'BUILDING_PLOT'],
  ['terrain', 'BUILDING_PLOT'],
  ['terreno', 'BUILDING_PLOT'],
  ['parking-space', 'PARKING_SPACE_OR_GARAGE'],
  ['parkplatz', 'PARKING_SPACE_OR_GARAGE'],
  ['place-de-parc', 'PARKING_SPACE_OR_GARAGE'],
  ['posto-auto', 'PARKING_SPACE_OR_GARAGE'],
]);

/**
 * The segments that name the portal's "everything" category, in each of the four languages.
 *
 * They name no property type and no place, so neither is read out of one. A URL that carries one
 * searches every type, which is what the category itself means.
 */
const CATEGORY_SEGMENTS = new Set(['real-estate', 'immobilien', 'immobilier', 'immobili']);

/**
 * The trailing segment of a search result page, which names no place either.
 *
 * The four words are the same ones Homegate serves, because both portals publish agency URLs under
 * them: `/it/immobili/affittare/lista-annunci` ends in the Italian result page segment.
 */
const SRP_SEGMENTS = new Set(['matching-list', 'trefferliste', 'liste-annonces', 'lista-annunci']);

/**
 * @param {unknown} value
 * @returns {string|null} the value as trimmed text, or null when it holds nothing
 */
function nonEmpty(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * Read one of the API's numbers.
 *
 * Deliberately not `extractNumber`: that parser is built for the German-formatted text the scraping
 * providers pull off a page, where a dot groups thousands, and it would misread a JSON decimal.
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

/**
 * The structured search a pasted URL describes.
 *
 * Only what the URL spells in its path is read: the offer type, the property type and the place.
 * The path is `/{lang}/{category}/{offerType}/{propertyType}/{location}[/{srp}]`, and its segments
 * are classified one by one rather than read by their position. The `/xx/` prefix is the language
 * when it is present; a URL without one is in the language its offer type word is written in.
 *
 * The last leftover segment is taken as the place rather than the first, because the path can carry
 * a property word this does not map: `/de/immobilien/mieten/buero/ort-zuerich` names the place after
 * the word `buero`. Reading the first leftover would take `buero` for the place and never resolve
 * the town.
 *
 * The filters the portal's own filter panel writes into the query string are deliberately not
 * translated - their names were never measured on this portal, and a guessed name would send a
 * search that filters on something the user did not ask for.
 *
 * @param {string} url the search URL the user pasted
 * @returns {{lang: string, offerType: string|null, propertyType: string|null, location: string|null}|null}
 *   the location is the slug as the URL wrote it (`luogo-chiasso`), or null when the path names
 *   none. The whole result is null when the URL cannot be parsed at all.
 */
export function parseSearchUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const segments = pathname
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

  const offer = segments.map((segment) => OFFER_TYPE_SEGMENTS.get(segment)).find((entry) => entry != null) ?? null;
  const prefix = segments.find((segment) => LANGUAGES.has(segment));
  const propertyType =
    segments.map((segment) => PROPERTY_TYPE_SEGMENTS.get(segment)).find((type) => type != null) ?? null;

  const location =
    segments.findLast(
      (segment) =>
        !LANGUAGES.has(segment) &&
        !OFFER_TYPE_SEGMENTS.has(segment) &&
        !PROPERTY_TYPE_SEGMENTS.has(segment) &&
        !CATEGORY_SEGMENTS.has(segment) &&
        !SRP_SEGMENTS.has(segment),
    ) ?? null;

  return {
    lang: prefix ?? offer?.lang ?? 'de',
    offerType: offer?.offerType ?? null,
    propertyType,
    location,
  };
}

/**
 * Ask the search endpoint for one page.
 *
 * The endpoint refuses a request without a `datadome` cookie with 403 and names the challenge. The
 * cookie is minted by `lib/services/datadome.js`, reused from its on-disk store when this host was
 * already solved, and the request is retried once with it. The retry is worth a request and no
 * more: `tokenForBlock` refuses to buy a second solve for the same host within its cooldown, so a
 * search the endpoint keeps refusing fails the read instead of paying per page.
 *
 * @param {Object} body the request body
 * @returns {Promise<any|null>} the page payload, or null when it did not arrive
 */
async function requestPage(body) {
  const send = (cookie) =>
    fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: cookie == null ? REQUEST_HEADERS : { ...REQUEST_HEADERS, Cookie: cookie },
      body: JSON.stringify(body),
    });

  const token = readToken(HOST);
  let response = await send(token);

  if (response.status === 403) {
    const blocked = await response.text().catch(() => '');
    const solved = await tokenForBlock({
      status: response.status,
      body: blocked,
      host: HOST,
      userAgent: SOLVE_USER_AGENT,
      usedToken: token,
    });
    if (solved != null) response = await send(solved);
  }

  if (!response.ok) {
    // The endpoint names what it refused, and that body is the only place the reason appears.
    const refused = await response.text().catch(() => '');
    logger.error(
      `ImmoScout24.ch answered ${response.status} ${response.statusText}: ${refused.slice(0, 300)}`.trimEnd(),
    );
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (payload == null || !Array.isArray(payload.results)) {
    logger.error('ImmoScout24.ch returned a payload without search results. The search URL may be wrong.');
    return null;
  }
  return payload;
}

/**
 * Read a search, one page at a time.
 *
 * @param {string} url the search URL the job carries
 * @returns {Promise<Object[]>} the raw listings of every page read
 */
async function getListings(url) {
  const search = parseSearchUrl(url);
  if (search == null || search.offerType == null) {
    logger.error(`Could not read the ImmoScout24.ch search URL: ${url}`);
    return [];
  }

  // A path that names no place is the portal's own country-wide search, so it is read as one. A
  // path that does name a place and cannot resolve it is a different case: searching on without
  // the place would quietly answer the whole country for a job that asked for one town.
  const query = { offerType: search.offerType };
  if (search.location != null) {
    const geoTag = await resolveGeoLocationId({
      endpoint: GEO_ENDPOINT,
      slug: search.location,
      lang: search.lang,
    });
    if (geoTag == null) return [];
    query.location = { geoTags: [geoTag] };
  }
  if (search.propertyType != null) query.propertyType = search.propertyType;

  const listings = [];
  let maxFrom = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const from = (page - 1) * PAGE_SIZE;
    // `maxFrom` is the largest `from` the search accepts, so the walk stops once it would pass it.
    if (maxFrom != null && from > maxFrom) break;

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

    for (const result of answer.results) {
      if (result?.listing != null) listings.push(result.listing);
    }
    if (answer.results.length === 0) break;
    // The ceiling belongs to the search rather than to the page, so a page that omits it keeps the
    // one the pages before it reported.
    maxFrom = toNumber(answer.maxFrom) ?? maxFrom;
  }

  return listings;
}

/**
 * The language block the portal says is the listing's own.
 *
 * @param {any} o
 * @returns {any|null}
 */
function localizationBlock(o) {
  const localization = o?.localization;
  if (localization == null) return null;
  return localization[localization.primary] ?? null;
}

/** A url ending in an image file. */
const IMAGE_URL = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;

/**
 * The listing's first photograph.
 *
 * An L10N block carries documents next to pictures - DOCUMENT, PLAN, SALES_BROCHURE - and no type
 * marks a photograph, so the first attachment whose url is an image file is taken.
 *
 * @param {any} o
 * @returns {string|null}
 */
function firstImageUrl(o) {
  for (const attachment of localizationBlock(o)?.attachments ?? []) {
    const url = attachment?.url;
    if (typeof url === 'string' && IMAGE_URL.test(url)) return url;
  }
  return null;
}

/**
 * The address the response describes.
 *
 * The reverse-engineering docs name `geoCoordinates` and `geoTags` inside the address object but
 * not the street fields, so those are read by the camelCase spelling the rest of the payload uses.
 * A wrong guess here costs a geocoder lookup, not a listing.
 *
 * @param {any} address
 * @returns {string|null}
 */
function buildAddress(address) {
  if (address == null) return null;
  const street = [nonEmpty(address.street), nonEmpty(address.streetNumber)].filter((part) => part != null).join(' ');
  const town = [nonEmpty(address.zip), nonEmpty(address.city)].filter((part) => part != null).join(' ');
  const line = [street, town].filter((part) => part.length > 0).join(', ');
  return line.length > 0 ? line : null;
}

/**
 * The web page of a listing, built from its id.
 *
 * The search response carries no web url, and the docs say the slug scheme has to be read off the
 * live response first, which was not done. This is the `/de/d/<id>` shape the portal's listing
 * links use, and it is NOT verified against the live portal: a link that does not resolve costs a
 * click, and nothing in the pipeline reads it back.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
function listingLink(id) {
  const value = nonEmpty(id);
  return value == null ? null : `${BASE_URL}de/d/${value}`;
}

/**
 * @param {any} o one listing as the search endpoint answered it
 * @returns {ParsedListing}
 */
function normalize(o) {
  const copy = localizationBlock(o)?.text;
  // Nettomiete first, then the gross figure: the affordability check adds a Nebenkosten surcharge to
  // whatever stands here, so quoting the gross rent counts them twice, and a rent that is 25 % too
  // pessimistic still beats a listing dropped for want of a price. `prices.buy.price` is the whole
  // price of a purchase, and `prices.rent` is null on a buy listing.
  const price = toNumber(o.prices?.rent?.net ?? o.prices?.rent?.gross ?? o.prices?.buy?.price);

  return {
    id: buildHash(nonEmpty(o.id) ?? '', price == null ? null : String(price)),
    title: nonEmpty(copy?.title),
    link: listingLink(o.id),
    price,
    size: toNumber(o.characteristics?.livingSpace),
    rooms: toNumber(o.characteristics?.numberOfRooms),
    address: buildAddress(o.address),
    description: nonEmpty(copy?.description),
    publishedAt: publicationDate(o.meta?.createdAt),
    image: firstImageUrl(o),
    // The response carries the coordinates, and the pipeline's geocoder only looks an address up
    // when the listing is not located yet, so these skip that lookup.
    latitude: toNumber(o.address?.geoCoordinates?.latitude),
    longitude: toNumber(o.address?.geoCoordinates?.longitude),
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
  // Sorting rides in the request body as `sortBy: 'dateCreated'`, not in the URL.
  sortByDateParam: null,
  getListings,
  normalize,
};

export const metaInformation = {
  countries: ['ch'],
  name: 'ImmoScout24.ch',
  baseUrl: BASE_URL,
  id: 'immoscout24ch',
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
