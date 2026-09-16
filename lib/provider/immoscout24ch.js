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
 * The user pastes a search URL, and it is translated here into the structured query of
 * `POST /search/listings`. `POST /search/listings-by-url` would also take it: measured on this
 * host, the bare Chiasso apartment rental URL answered 200 with `total: 163` and the same URL with
 * its four filters answered 7, which is what the translation below produces. Reading through that
 * endpoint instead is a decision for the provider as a whole, not one this comment makes.
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
import { appHeaders } from '../services/smg/appHeaders.js';
import { readVerifiedPage, POISONED, UNKNOWN } from '../services/smg/poison.js';
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
 * How long one request may wait, in milliseconds. A bare `fetch` has no timeout of its own, so a
 * host that accepts the connection and then says nothing would hold a job run open.
 */
const REQUEST_TIMEOUT = 15000;

/**
 * The request headers of every search call.
 *
 * The user agent is the app's own, because the host is the app's. It is not what decides whether
 * the block can be solved: asked with no cookie through two Swiss residential exits, this host and
 * `api.homegate.ch` both answered `t=fe` - the challenge capsolver solves - to this agent, to a
 * Chrome 141 agent and to a Firefox 131 agent alike. The `bv` challenge an earlier note blamed on
 * a desktop agent was not reproduced by any of the six measurements.
 *
 * `SOLVE_USER_AGENT` is still handed to `tokenForBlock`, because capsolver accepts only the fixed
 * set of user agents it ships. The cookie is not bound to the user agent that earned it, which is
 * measured in `lib/services/datadome.js`.
 *
 * The app's `X-App-Id` is what holds the answer honest, so the request carries the app's header
 * set, the retry with the solved cookie included. The server does not validate the signature, so
 * the values only have the app's shape and a fresh pseudo signature is sent per request. Without the
 * header the endpoint serves the rewritten value set on nearly every answer, which is what
 * `lib/services/smg/poison.js` detects: measured on this host, the Chiasso search answered honest
 * values 12 times out of 12 with it, and 1 out of 12 without.
 */
const APP_USER_AGENT = 'immoscout24.ch.nextgen App Android/6.3.0';

/** The constant the app sends as its identity. Presence and a non-empty value are all the server reads. */
const APP_VERSION = 'Immoscout24/6.3.0(6300000)/Android/37';

/**
 * The headers of one search request: the app's own set, with a pseudo signature.
 * @returns {Record<string, string>}
 */
const requestHeaders = () => ({
  ...appHeaders({ userAgent: APP_USER_AGENT, appVersion: APP_VERSION }),
  'Content-Type': 'application/json',
});

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
 * The letter that scales a price in a search URL, and its factor.
 *
 * The portal's own client accepts `pt=2t` for two thousand francs. A price without a letter is
 * francs. The table is the client's own.
 */
const PRICE_UNITS = { h: 100, t: 1000, g: 10000, f: 100000, m: 1000000 };

/**
 * The alphabet of the `an` facility bitmask, and the bits one character carries.
 *
 * The mask is base 32 over this alphabet, read right to left: the rightmost character holds bits 0
 * to 4, the next one bits 5 to 9, and so on. The client's own decoder threw on a character outside
 * the alphabet, so a value this cannot read is dropped whole instead of half read.
 */
const FACILITY_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
const BITS_PER_CHARACTER = 5;

/**
 * Which facility each bit of the `an` mask asks for, as the field the API query carries it in.
 *
 * Only the bits the reverse-engineering document names appear here. A bit this table does not name
 * is ignored, because a guessed facility would narrow the search to one the user did not ask for.
 * The field names are read from the client's own body builder, which writes one boolean per
 * facility and omits the rest.
 *
 * Each field is live-confirmed on `POST /search/listings`: asking for it in a Chiasso rental search
 * narrowed the 257 unfiltered results, for example `hasElevator` to 120, `hasParkingOrGarage` to
 * 77 and `hasBalcony` to 90.
 */
const FACILITY_FIELDS = new Map([
  [0, 'isWheelchairAccessible'],
  [1, 'arePetsAllowed'],
  [4, 'isNewBuilding'],
  [5, 'isMinergieGeneral'],
  [6, 'isMinergieCertified'],
  [7, 'hasSwimmingPool'],
  [8, 'hasElevator'],
  [9, 'isOldBuilding'],
  [12, 'hasBalcony'],
  [13, 'hasNiceView'],
  [14, 'hasFireplace'],
  [15, 'hasParking'],
  [16, 'hasGarage'],
  [17, 'isChildFriendly'],
  [18, 'hasParkingOrGarage'],
  [19, 'isMinergie'],
]);

/**
 * The API category each object type code of the `pty` parameter names.
 *
 * The portal's client maps a code to an internal type and then to a list of categories, and some
 * codes stand for more than one category. Only the codes the reverse-engineering document names
 * appear here; an unnamed code is ignored rather than guessed.
 *
 * Two codes need a word. Code 62 is FURNISHED_FLAT, and the client folds it onto the type
 * APARTMENT, which would widen a furnished-flat search to every apartment. The API has the exact
 * category FURNISHED_FLAT, and it is live-confirmed as a narrowing filter: 8 results in a Chiasso
 * rental search against 257 unfiltered, and 1588 against 48139 country-wide. Code 62 therefore
 * maps to FURNISHED_FLAT.
 *
 * All other category lists here are live-confirmed as real API categories, either narrowed in a
 * Chiasso rental search (APARTMENT 171, SINGLE_ROOM 3, ATTIC_FLAT 1, GARAGE 1, SINGLE_HOUSE 1,
 * UNDERGROUND_SLOT 1, VILLA 1, SHOP 10, DEPARTMENT_STORE 1) or non-empty country-wide against
 * 48139 unfiltered (ROW_HOUSE 144, RUSTICO 1, CHALET 137, ROOF_FLAT 657, MAISONETTE 11, DUPLEX
 * 665, LOFT 136, OPEN_SLOT 1566, COVERED_SLOT 231, DOUBLE_GARAGE 22, HOBBY_ROOM 413,
 * TERRACE_HOUSE 9, TERRACE_FLAT 123, ATELIER 259, PRACTICE 232, FACTORY 565).
 */
const OBJECT_TYPE_CATEGORIES = new Map([
  [1, ['APARTMENT']],
  [3, ['SINGLE_ROOM']],
  [4, ['ROW_HOUSE']],
  [6, ['ATTIC_FLAT']],
  [7, ['RUSTICO']],
  [8, ['CHALET']],
  [9, ['GARAGE']],
  [21, ['ROOF_FLAT']],
  [24, ['MAISONETTE', 'DUPLEX']],
  [26, ['BUNGALOW', 'SINGLE_HOUSE', 'ENGADINE_HOUSE']],
  [55, ['LOFT']],
  [62, ['FURNISHED_FLAT']],
  [69, ['UNDERGROUND_SLOT']],
  [70, ['OPEN_SLOT']],
  [71, ['COVERED_SLOT']],
  [72, ['DOUBLE_GARAGE']],
  [74, ['HOBBY_ROOM']],
  [98, ['TERRACE_HOUSE']],
  [99, ['TERRACE_FLAT']],
  [103, ['VILLA']],
  [127, ['SINGLE_ROOM']],
  [129, ['GARAGE']],
  [130, ['OPEN_SLOT']],
  [131, ['SHOP']],
  [132, ['ATELIER']],
  [133, ['PRACTICE']],
  [134, ['FACTORY']],
  [135, ['DEPARTMENT_STORE']],
]);

/**
 * The categories that name a commercial object.
 *
 * A search whose categories are all commercial answers no residential row, and both the honest and
 * the poisoned value set then lack `prices.rent.net`, so the detector's first signal cannot judge
 * it. The list is the non-residential half of {@link OBJECT_TYPE_CATEGORIES}.
 */
const COMMERCIAL_CATEGORIES = new Set([
  'SHOP',
  'DEPARTMENT_STORE',
  'PRACTICE',
  'FACTORY',
  'ATELIER',
  'GARAGE',
  'OPEN_SLOT',
  'COVERED_SLOT',
  'DOUBLE_GARAGE',
  'UNDERGROUND_SLOT',
  'HOBBY_ROOM',
]);

/**
 * Whether the URL's categories name commercial objects only.
 *
 * @param {string[]|null|undefined} categories the categories of the request's query
 * @returns {boolean}
 */
function isCommercialOnly(categories) {
  return (
    Array.isArray(categories) && categories.length > 0 && categories.every((name) => COMMERCIAL_CATEGORIES.has(name))
  );
}

/**
 * The sort each name the `o` parameter accepts asks for.
 *
 * `resultingsearchableprice` names no field of its own: the price field depends on the offer type,
 * so it is resolved after the offer type is known. An `o` value outside this table is ignored, and
 * the provider keeps its own newest-first sort.
 */
const SORT_NAMES = new Map([
  ['sorttoplisting', { sortBy: 'listingType' }],
  ['resultingsearchableprice', { price: true }],
  ['place', { sortBy: 'place' }],
  ['nr', { sortBy: 'numberOfRooms' }],
  ['datecreated', { sortBy: 'dateCreated' }],
  ['exclusive', { sortBy: 'exclusive' }],
  ['relevance', { sortBy: 'relevance' }],
]);

/**
 * Read one of the URL's whole numbers.
 *
 * This matches the portal's own reader: `parseInt` base 10, and a value it cannot read is absent.
 * A malformed bound must not become a bound of zero, which would filter on a number the user never
 * gave.
 *
 * @param {URLSearchParams} params the URL's query string
 * @param {string} name the parameter to read
 * @returns {number|null}
 */
function readInt(params, name) {
  const raw = params.get(name);
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Read one of the URL's decimal numbers, for the room count that keeps a half.
 *
 * @param {URLSearchParams} params the URL's query string
 * @param {string} name the parameter to read
 * @returns {number|null}
 */
function readFloat(params, name) {
  const raw = params.get(name);
  if (raw == null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Read one of the URL's prices, with the letter that scales it.
 *
 * @param {URLSearchParams} params the URL's query string
 * @param {string} name the parameter to read
 * @returns {number|null}
 */
function readPrice(params, name) {
  const raw = params.get(name);
  if (raw == null) return null;
  const unit = PRICE_UNITS[raw.slice(-1)] ?? 1;
  const parsed = Number.parseInt(unit === 1 ? raw : raw.slice(0, -1), 10);
  return Number.isNaN(parsed) ? null : parsed * unit;
}

/**
 * A `{from, to}` range with only the bounds the URL gave, or null when it gave none.
 *
 * The API reads an unused range as absent rather than as an open one, so a range with one bound
 * carries that bound alone.
 *
 * @param {number|null} from the lower bound
 * @param {number|null} to the upper bound
 * @returns {{from?: number, to?: number}|null}
 */
function buildRange(from, to) {
  if (from == null && to == null) return null;
  return { ...(from == null ? {} : { from }), ...(to == null ? {} : { to }) };
}

/**
 * The `r` radius in metres.
 *
 * A value under a thousand is kilometres, which is how the portal's own client reads it and how its
 * filter panel writes it. A value of a thousand or more is already metres.
 *
 * The API radius field is live-confirmed: around Chiasso a rental search answered 348 results at
 * 500 metres and 650 at 5000, against 257 with no radius. The radius widens a place search, so it
 * is carried only next to a place.
 *
 * @param {URLSearchParams} params the URL's query string
 * @returns {number|null}
 */
function readRadius(params) {
  const value = readInt(params, 'r');
  if (value == null) return null;
  return value < 1000 ? value * 1000 : value;
}

/**
 * The API categories the `pty` parameter names.
 *
 * The parameter holds comma-separated numeric codes. An unnamed code contributes nothing, and a
 * URL whose codes are all unnamed asks for no category at all.
 *
 * @param {URLSearchParams} params the URL's query string
 * @returns {string[]|null}
 */
function readObjectTypes(params) {
  const raw = nonEmpty(params.get('pty'));
  if (raw == null) return null;
  const categories = [];
  for (const part of raw.split(',')) {
    const names = OBJECT_TYPE_CATEGORIES.get(Number.parseInt(part.trim(), 10));
    if (names == null) continue;
    for (const name of names) {
      if (!categories.includes(name)) categories.push(name);
    }
  }
  return categories.length > 0 ? categories : null;
}

/**
 * The facility fields the `an` bitmask asks for.
 *
 * The mask is read right to left, five bits per character, and the bits the table does not name
 * contribute nothing. A character outside the alphabet makes the whole value unreadable, and an
 * unreadable value asks for no facility: half reading it would filter on a facility the user did
 * not name.
 *
 * @param {URLSearchParams} params the URL's query string
 * @returns {string[]|null}
 */
function readFacilities(params) {
  const raw = nonEmpty(params.get('an'));
  if (raw == null) return null;
  const fields = [];
  for (let index = 0; index < raw.length; index++) {
    const characterBits = FACILITY_ALPHABET.indexOf(raw.charAt(index));
    if (characterBits < 0) return null;
    const position = raw.length - 1 - index;
    for (let bit = 0; bit < BITS_PER_CHARACTER; bit++) {
      if ((characterBits & (1 << bit)) === 0) continue;
      const field = FACILITY_FIELDS.get(position * BITS_PER_CHARACTER + bit);
      if (field != null && !fields.includes(field)) fields.push(field);
    }
  }
  return fields.length > 0 ? fields : null;
}

/**
 * The sort the `o` parameter asks for.
 *
 * The parameter is `<name>-<direction>`. An unknown name is ignored so that the provider keeps its
 * own newest-first sort, and an absent or unknown direction reads as `desc`, which is the client's
 * own default. The sort is live-confirmed: `numberOfRooms asc` and `monthlyRent asc` both changed
 * the first result while the total stayed at 257.
 *
 * @param {URLSearchParams} params the URL's query string
 * @param {string|null} offerType the offer type the URL path named
 * @returns {{sortBy: string, sortDirection: string}|null}
 */
function readSort(params, offerType) {
  const raw = nonEmpty(params.get('o'));
  if (raw == null) return null;
  const [name, direction] = raw.split('-');
  const entry = SORT_NAMES.get(name.toLowerCase());
  if (entry == null) return null;
  const sortBy = entry.price ? (offerType === 'BUY' ? 'purchasePrice' : 'monthlyRent') : entry.sortBy;
  return { sortBy, sortDirection: direction === 'asc' || direction === 'desc' ? direction : 'desc' };
}

/**
 * The first page of the walk, from the `pn` parameter.
 *
 * `pn` is 1-based, and the API reads `from = (pn - 1) * 20`, which is live-confirmed: `pn=2`
 * answered a different first result and reported `from: 20`. The first page is the walk's own
 * start, so it is reported as absent.
 *
 * @param {URLSearchParams} params the URL's query string
 * @returns {number|null}
 */
function readFirstPage(params) {
  const page = readInt(params, 'pn');
  return page != null && page > 1 ? page : null;
}

/**
 * The filters a pasted URL spells in its query string, as the API reads them.
 *
 * The query string is a second grammar beside the path: `parseSearchUrl` reads the path's words,
 * and this reads the filter panel's short parameter names. The names and the field spellings come
 * from the portal's own web client, which posts to the same endpoint the app does, and every field
 * here was then confirmed live against `POST /search/listings`.
 *
 * The surface fields settle a conflict the documentation left open. The web client posts
 * `livingSpace`, `lotSize` and `totalFloorSpace`, while the mobile model is documented as
 * `surfaceLivingRange`, `surfacePropertyRange` and `surfaceUsableRange`. A three-way measurement
 * on a Chiasso rental search settles it for the living space: 257 results with no surface filter,
 * 6 with `livingSpace: {from: 200}`, and 257 again with `surfaceLivingRange: {from: 200}`. The web
 * spelling is the one the server honours, so it is the one used here. The other two were measured
 * the same way: `lotSize` 4 against 257 with `surfacePropertyRange` 257, and `totalFloorSpace` 44
 * against 257 with `surfaceUsableRange` 257.
 *
 * One price pair serves both offer types: `pf`/`pt` fill `monthlyRent` on a rent search and
 * `purchasePrice` on a buy search, and the offer type decides which. Live-confirmed on both: on a
 * rent search `monthlyRent` moved the total and `purchasePrice` did not, and on a buy search
 * `purchasePrice` moved it while `monthlyRent` did not.
 *
 * @param {string} url the search URL the user pasted
 * @returns {{query: Object, radius: number|null, sortBy: string|null, sortDirection: string|null,
 *   page: number|null}} `query` holds the API query fields the query string asks for, without
 *   `offerType`, `propertyType` and `location`; `radius` is kept apart because it belongs inside
 *   `location`, which the caller builds once the place is resolved. The whole result is null when
 *   the URL cannot be parsed at all.
 */
export function parseSearchFilters(url) {
  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }

  // The price field depends on the offer type, so the path is read here too. Without an offer type
  // the price target is unknown and the pair is dropped rather than sent at the wrong target.
  const offerType = parseSearchUrl(url)?.offerType ?? null;

  const query = {};
  const livingSpace = buildRange(readInt(params, 'slf'), readInt(params, 'slt'));
  if (livingSpace != null) query.livingSpace = livingSpace;
  const numberOfRooms = buildRange(readFloat(params, 'nrf'), readFloat(params, 'nrt'));
  if (numberOfRooms != null) query.numberOfRooms = numberOfRooms;

  const price = buildRange(readPrice(params, 'pf'), readPrice(params, 'pt'));
  if (price != null && offerType === 'RENT') query.monthlyRent = price;
  if (price != null && offerType === 'BUY') query.purchasePrice = price;

  const lotSize = buildRange(readInt(params, 'spf'), readInt(params, 'spt'));
  if (lotSize != null) query.lotSize = lotSize;
  const totalFloorSpace = buildRange(readInt(params, 'suf'), readInt(params, 'sut'));
  if (totalFloorSpace != null) query.totalFloorSpace = totalFloorSpace;

  const categories = readObjectTypes(params);
  if (categories != null) query.categories = categories;

  for (const field of readFacilities(params) ?? []) query[field] = true;

  const sort = readSort(params, offerType);
  return {
    query,
    radius: readRadius(params),
    sortBy: sort?.sortBy ?? null,
    sortDirection: sort?.sortDirection ?? null,
    page: readFirstPage(params),
  };
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
 * The query string is a second grammar with its own short names, and it is read by
 * {@link parseSearchFilters}.
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
      headers: cookie == null ? requestHeaders() : { ...requestHeaders(), Cookie: cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
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
  const filters = parseSearchFilters(url);
  if (search == null || filters == null || search.offerType == null) {
    logger.error(`Could not read the ImmoScout24.ch search URL: ${url}`);
    return [];
  }

  // A path that names no place is the portal's own country-wide search, so it is read as one. A
  // path that does name a place and cannot resolve it is a different case: searching on without
  // the place would quietly answer the whole country for a job that asked for one town.
  const query = { ...filters.query, offerType: search.offerType };
  if (search.location != null) {
    const geoTag = await resolveGeoLocationId({
      endpoint: GEO_ENDPOINT,
      slug: search.location,
      lang: search.lang,
      headers: requestHeaders(),
    });
    if (geoTag == null) return [];
    query.location = { geoTags: [geoTag] };
    // A radius widens a search around a place, so it means nothing without one.
    if (filters.radius != null) query.location.radius = filters.radius;
  }
  if (search.propertyType != null) query.propertyType = search.propertyType;

  // The URL's own sort wins when it names one the API accepts. Without one the provider asks for
  // the newest first, which is what lets the walk stop early.
  const sortBy = filters.sortBy ?? 'dateCreated';
  const sortDirection = filters.sortDirection ?? 'desc';
  const firstPage = filters.page ?? 1;
  const lastPage = firstPage + MAX_PAGES - 1;
  // The endpoint rewrites the numbers on a random share of its answers. The net-price signal can
  // judge a residential rent search; a commercial-only one carries the field in neither value set,
  // so the detector falls to the numeric filters, and to `unknown` when the URL set none.
  const expectNet = search.offerType === 'RENT' && !isCommercialOnly(query.categories);

  const listings = [];
  let maxFrom = null;
  let saidUnverified = false;

  for (let page = firstPage; page <= lastPage; page++) {
    const from = (page - 1) * PAGE_SIZE;
    // `maxFrom` is the largest `from` the search accepts, so the walk stops once it would pass it.
    if (maxFrom != null && from > maxFrom) break;

    const body = {
      query,
      sortBy,
      sortDirection,
      from,
      size: PAGE_SIZE,
      trackTotalHits: true,
      fieldset: 'srp-list',
    };
    // The sort travels beside the query on the wire, so the detector is handed it inside the query
    // it judges the answer against.
    const { answer, verdict, attempts } = await readVerifiedPage({
      requestPage,
      body,
      query: { ...query, sortBy, sortDirection },
      expectNet,
    });
    if (answer == null) break;

    if (verdict.verdict === POISONED) {
      logger.error(
        `ImmoScout24.ch: the page from=${from} of ${url} stayed poisoned after ${attempts} attempts (${verdict.reason}). Its rows are dropped and the walk stops there.`,
      );
      break;
    }

    // A page the detector cannot judge is kept: dropping it would leave a search that sets no
    // numeric filter with nothing at all. The line is said once, not once per page.
    if (verdict.verdict === UNKNOWN && !saidUnverified) {
      saidUnverified = true;
      logger.warn(
        `ImmoScout24.ch: the page from=${from} of ${url} could not be verified (${verdict.reason}). Its rows are kept.`,
      );
    }

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
 * The three names are read off the live response, which carries the same address model Homegate
 * does: `street`, `postalCode`, `locality`, `region`, `geoCoordinates` and `geoTags`, and neither
 * `city` nor `zip` nor `streetNumber`. `street` already holds the house number ("Corso San
 * Gottardo 24"), so no number is appended.
 *
 * @param {any} address
 * @returns {string|null}
 */
function buildAddress(address) {
  if (address == null) return null;
  const street = nonEmpty(address.street) ?? '';
  const town = [nonEmpty(address.postalCode), nonEmpty(address.locality)].filter((part) => part != null).join(' ');
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
