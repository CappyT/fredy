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
 * Both apps are the same SMG code base. The query DSL, the response model and the field mapping are
 * documented in `reverse-engineered-homegate.md`; `reverse-engineered-immoscout24ch.md` holds this
 * portal's own host and app values.
 */

import { buildHash, isOneOf } from '../utils.js';
import logger from '../services/logger.js';
import { publicationDate } from '../utils/publicationDate.js';
import { readToken, tokenForBlock, SOLVE_USER_AGENT } from '../services/datadome.js';
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
 * The request headers of every call.
 *
 * The user agent is capsolver's, not the app's: the `datadome` cookie is bound to the user agent
 * that earned it, and capsolver only accepts its own fixed set. The app's `X-App-Id` and
 * `X-App-Time` are deliberately absent - once the cookie is valid the server accepts a request
 * without them, which is what makes a server-side provider possible at all.
 */
const REQUEST_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': SOLVE_USER_AGENT,
};

/** The four languages the portal serves. */
const LANGUAGES = new Set(['de', 'fr', 'it', 'en']);

/** The offer type a URL path segment names, in each of the four languages. */
const OFFER_TYPE_SEGMENTS = new Map([
  ['mieten', 'RENT'],
  ['rent', 'RENT'],
  ['louer', 'RENT'],
  ['affitto', 'RENT'],
  ['kaufen', 'BUY'],
  ['buy', 'BUY'],
  ['acheter', 'BUY'],
  ['vente', 'BUY'],
  ['vendita', 'BUY'],
  ['comprare', 'BUY'],
]);

/** The property type a URL path segment names, in each of the four languages. */
const PROPERTY_TYPE_SEGMENTS = new Map([
  ['wohnung', 'APARTMENT'],
  ['apartment', 'APARTMENT'],
  ['appartement', 'APARTMENT'],
  ['appartamento', 'APARTMENT'],
  ['haus', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['house', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['maison', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['casa', 'HOUSE_OR_CHALET_OR_RUSTICO'],
  ['grundstueck', 'BUILDING_PLOT'],
  ['plot', 'BUILDING_PLOT'],
  ['terrain', 'BUILDING_PLOT'],
  ['terreno', 'BUILDING_PLOT'],
  ['parkplatz', 'PARKING_SPACE_OR_GARAGE'],
  ['parking', 'PARKING_SPACE_OR_GARAGE'],
  ['garage', 'PARKING_SPACE_OR_GARAGE'],
]);

/**
 * The kind of place a URL slug names, by its prefix, and the geoTags prefix the API spells the same
 * kind with.
 *
 * The autocomplete answers several places for one name - the live run got 67 for Zurich - so a
 * search for `ort-zuerich` must not resolve to the canton that shares its name. The URL slug and
 * the geoTags value are built from the same words, which is what makes this mapping safe.
 */
const LOCATION_KINDS = [
  { slugs: ['ort', 'stadt', 'city', 'place', 'lieu', 'luogo'], tag: 'geo-city-' },
  { slugs: ['kanton', 'canton'], tag: 'geo-canton-' },
  { slugs: ['plz', 'zip', 'postcode', 'postleitzahl'], tag: 'geo-zipcode-' },
];

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
 * @param {string|URL} url
 * @param {string} what - Named in the log line when the request fails.
 * @returns {Promise<any|null>}
 */
async function getJson(url, what) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    logger.error(`Error fetching ${what} from ImmoScout24.ch: ${response.status} ${response.statusText}`);
    return null;
  }
  return response.json().catch(() => null);
}

/**
 * The place a URL slug names, and the kind of place it is.
 *
 * The prefix is only stripped when it names a kind: a place whose own name carries a hyphen
 * (`zuerich-seefeld`) would otherwise be read as a place called `seefeld`.
 *
 * @param {string} slug the last segment of the search URL's path
 * @returns {{name: string, kindTag: string|null}}
 */
function locationFrom(slug) {
  const at = slug.indexOf('-');
  if (at > 0) {
    const kind = LOCATION_KINDS.find((candidate) => candidate.slugs.includes(slug.slice(0, at).toLowerCase()));
    if (kind != null) return { name: slug.slice(at + 1), kindTag: kind.tag };
  }
  return { name: slug, kindTag: null };
}

/**
 * The structured search a pasted URL describes.
 *
 * Only what the URL spells in its path is read: the offer type, the property type and the place.
 * The filters the portal's own filter panel writes into the query string are deliberately not
 * translated - their names were never measured on this portal, and a guessed name would send a
 * search that filters on something the user did not ask for.
 *
 * @param {string} url the search URL the user pasted
 * @returns {{lang: string, offerType: string|null, propertyType: string|null, location: {name: string, kindTag: string|null}|null}|null}
 *   null when the URL cannot be parsed at all
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
    .filter((segment) => segment.length > 0);

  const words = segments.map((segment) => segment.toLowerCase());
  const lang = words.find((word) => LANGUAGES.has(word)) ?? 'de';
  const offerType = words.map((word) => OFFER_TYPE_SEGMENTS.get(word)).find((type) => type != null) ?? null;
  const propertyType = words.map((word) => PROPERTY_TYPE_SEGMENTS.get(word)).find((type) => type != null) ?? null;

  const last = segments[segments.length - 1];
  const lastWord = words[words.length - 1];
  const namesSomethingElse =
    last == null ||
    OFFER_TYPE_SEGMENTS.has(lastWord) ||
    PROPERTY_TYPE_SEGMENTS.has(lastWord) ||
    LANGUAGES.has(lastWord);

  return { lang, offerType, propertyType, location: namesSomethingElse ? null : locationFrom(last) };
}

/**
 * The one geoTags value a search location becomes.
 *
 * `GET /geo/locations` is an autocomplete, so the answer to one name is a list. The candidate whose
 * id carries the kind the URL slug named wins; without a kind the first answer is taken, which is
 * the autocomplete's own ranking.
 *
 * The field the id sits in is the one part of this response that neither reverse-engineering
 * document spells out - `id` and `geoTag` are the two spellings it could carry, and both are read.
 *
 * @param {{name: string, kindTag: string|null}} location
 * @param {string} lang
 * @returns {Promise<string[]|null>} the geoTags of the location, or null when it did not resolve
 */
async function resolveGeoTags(location, lang) {
  const url = new URL(GEO_ENDPOINT);
  url.searchParams.set('lang', lang);
  url.searchParams.set('name', location.name);

  const answer = await getJson(url, 'the locations');
  if (answer == null) return null;

  const candidates = (Array.isArray(answer) ? answer : (answer.results ?? []))
    .map((entry) => nonEmpty(entry?.id) ?? nonEmpty(entry?.geoTag))
    .filter((tag) => tag != null);

  const wanted = location.kindTag == null ? null : candidates.find((tag) => tag.startsWith(location.kindTag));
  const tag = wanted ?? candidates[0];
  return tag == null ? null : [tag];
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

  const geoTags = search.location == null ? null : await resolveGeoTags(search.location, search.lang);
  const query = { offerType: search.offerType };
  if (search.propertyType != null) query.propertyType = search.propertyType;
  if (geoTags != null) query.location = { geoTags };

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
