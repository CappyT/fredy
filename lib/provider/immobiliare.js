/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Immobiliare.it, Italy's largest property portal.
 *
 * The portal answers a search in one of two shapes, and this provider reads both.
 *
 * A town search ("/vendita-case/milano/") is a Next.js page whose first page of results is server
 * rendered into `__NEXT_DATA__`. It need not be read that way: the endpoint below answers a town
 * search as readily as a map one, and the only thing missing from the url is the number the portal
 * calls the town by. `lib/services/immobiliare/` looks that number up - through the geography
 * service the android app uses, which is on another host and behind nothing - and a town search
 * then costs no browser at all.
 *
 * What is left for the page is a search the url cannot be read into: a category the table does not
 * carry, a place the geography service does not know. That page is behind DataDome, which the
 * shared browser clears from a residential connection but not from a datacenter one, so a walled
 * render falls through to the service `FREDY_CHALLENGE_SOLVER_URL` names.
 *
 * A map search ("/search-list/?vrt=...") renders in the browser instead, and its markup carries no
 * results at all. Those come from `search-list/listings`, the endpoint the page calls once it is
 * running - which needs neither browser nor solver, because DataDome guards the pages and not it.
 *
 * The endpoint answers 25 adverts at a time and counts the pages, so a run reads them all. It is
 * where a town search goes for its later pages as well: the rendered page reports the search it
 * ran, sort included, which is what the endpoint wants - the town itself is named by the path and
 * never reaches the query. One render per run therefore covers any number of pages.
 *
 * Both shapes end in the same payload, so one `normalize` reads either.
 */

import { buildHash, isOneOf, sleep } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import { readNextData } from '../utils/priceExtractors.js';
import puppeteerExtractor from '../services/extractor/puppeteerExtractor.js';
import { solveChallenge } from '../services/extractor/challengeSolver.js';
import { translateSearchUrl } from '../services/immobiliare/web-translator.js';
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

/** The query parameter naming the result page, at the endpoint as on the page. */
const PAGE_PARAM = 'pag';

/** How many result pages one run reads, so a search covering a whole province cannot walk forever. */
const MAX_PAGES = 20;

/**
 * How long to wait between two result pages.
 *
 * The endpoint is not the half DataDome guards, but a walk that asks for twenty pages as fast as
 * the network allows is what earns that guard. The jitter keeps the gaps from being identical.
 */
const PAGE_DELAY_MS = 1_000;
const PAGE_JITTER_MS = 800;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Read a rendered search page: its results, the search it ran, and how many pages that search has.
 *
 * @param {string|null|undefined} html the raw html of a search result page
 * @returns {{results: any[], criteria: Record<string, any>|null, maxPages: number}|null} the page,
 *   or null when it carried no payload
 */
export function parseSearch(html) {
  const queries = readNextData(html)?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return null;

  const query = queries.find((entry) => Array.isArray(entry?.queryKey) && entry.queryKey[0] === LIST_QUERY_KEY);
  const results = query?.state?.data?.results;
  if (!Array.isArray(results)) return null;

  const criteria = query.queryKey[1];
  return {
    results,
    criteria: criteria != null && typeof criteria === 'object' ? criteria : null,
    maxPages: Number(query.state.data.maxPages) || 1,
  };
}

/**
 * @param {string|null|undefined} html the raw html of a search result page
 * @returns {any[]|null} the raw results, or null when the page carried no payload
 */
export function parseListings(html) {
  return parseSearch(html)?.results ?? null;
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
 * Translate a town search into the call its page makes for the pages after the first.
 *
 * A town is named by the path rather than by the query, so the criteria cannot be lifted off the
 * url the way a map search's are. They come from the page's own payload instead: the search it
 * reports having run, sort included.
 *
 * @param {string} url a town search url
 * @param {Record<string, any>|Array<[string, string]>} criteria the search to run, either as the
 *   rendered page reports it or as the url was read into
 * @returns {string} the endpoint url to request
 */
export function convertTownSearchToApi(url, criteria) {
  const parsed = new URL(url);
  const endpoint = new URL(LISTINGS_ENDPOINT_PATH, BASE_URL);
  // Appended rather than set: the website says several things under one name, and a search for two
  // kinds of house is not a search for the second of them.
  const pairs = Array.isArray(criteria) ? criteria : Object.entries(criteria);
  for (const [key, value] of pairs) endpoint.searchParams.append(key, String(value));
  endpoint.searchParams.set('path', parsed.pathname);
  return endpoint.toString();
}

/**
 * Ask the endpoint for one page of a search.
 *
 * @param {string} endpoint the endpoint url the search translates to
 * @param {number} page the page to read, counted from one
 * @returns {Promise<{results: any[], maxPages: number}|null>} the page, or null when it did not arrive
 */
async function requestApiPage(endpoint, page) {
  const target = new URL(endpoint);
  target.searchParams.set(PAGE_PARAM, String(page));

  const response = await fetch(target, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      Referer: BASE_URL,
    },
  });

  if (!response.ok) {
    // The endpoint validates what it is sent and names what it refused - a 422 reads
    // `{"errors":[{"message":"...","path":"energyEfficiencyId"}]}` - and that body is the only
    // place the reason appears.
    const refused = await response.text().catch(() => '');
    logger.error(
      `Immobiliare.it answered ${response.status} ${response.statusText}: ${refused.slice(0, 300)}`.trimEnd(),
    );
    return null;
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.results)) {
    logger.error('Immobiliare.it returned a payload without search results. The search URL may be wrong.');
    return null;
  }
  // The endpoint counts the pages itself, which is what says whether another one is worth asking for.
  return { results: payload.results, maxPages: Number(payload.maxPages) || 1 };
}

/**
 * Read a search from the endpoint, one page at a time.
 *
 * @param {string} endpoint the endpoint url the search translates to
 * @param {number} from the first page to read, which is the second one for a town search
 * @param {number} [known] how many pages the search has, when the caller has already been told
 * @returns {Promise<any[]>} the raw results of every page read
 */
async function walkApi(endpoint, from, known) {
  const results = [];
  let total = known ?? MAX_PAGES;

  for (let page = from; page <= Math.min(total, MAX_PAGES); page++) {
    if (page > from) await sleep(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);

    const answer = await requestApiPage(endpoint, page);
    if (answer == null) break;
    results.push(...answer.results);
    total = answer.maxPages;
  }

  if (total > MAX_PAGES) {
    logger.warn(`Immobiliare.it: stopped after ${MAX_PAGES} pages. Narrow the search to see the rest.`);
  }
  return results;
}

/**
 * @param {string} url a map search url
 * @returns {Promise<any[]>} the raw results of every page the search has
 */
async function getListingsFromApi(url) {
  return walkApi(convertMapSearchToApi(url), 1);
}

/**
 * @param {string} url a town search url
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of every page the search has
 */
async function getListingsFromPage(url, browser) {
  logger.debug(`Immobiliare.it: ${url} has to be rendered; the endpoint cannot be asked for it.`);
  const rendered = await puppeteerExtractor(url, 'body', { browser, name: 'immobiliare' });
  const first = parseSearch(rendered) ?? parseSearch((await solveChallenge(url, 'Immobiliare.it'))?.html);
  if (first == null) {
    logger.error('Immobiliare.it returned a page without search results. The search URL may be wrong.');
    return [];
  }
  // A page that names no criteria leaves nothing to ask the endpoint with, so it stands alone.
  if (first.criteria == null || first.maxPages <= 1) return first.results;

  const rest = await walkApi(convertTownSearchToApi(url, first.criteria), 2, first.maxPages);
  return [...first.results, ...rest];
}

/**
 * @param {string} url the search url, with the sort parameter already appended
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of every page the search has
 */
async function getListings(url, browser) {
  if (new URL(url).pathname === MAP_SEARCH_PATH) return getListingsFromApi(url);

  const criteria = await translateSearchUrl(url);
  if (criteria != null) {
    const endpoint = convertTownSearchToApi(url, criteria);
    const first = await requestApiPage(endpoint, 1);
    // The endpoint is the judge of its own parameters, and it refuses a filter whose value is not
    // in the shape it expects rather than ignoring it. A refusal is therefore a url this could not
    // read after all, and the page still can - answering nothing would be the one wrong move.
    if (first != null) {
      const rest = first.maxPages > 1 ? await walkApi(endpoint, 2, first.maxPages) : [];
      return [...first.results, ...rest];
    }
    logger.warn('Immobiliare.it refused the search read out of the url, so it is rendered instead.');
  }

  return getListingsFromPage(url, browser);
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
