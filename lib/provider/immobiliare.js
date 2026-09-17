/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Immobiliare.it, Italy's largest property portal.
 *
 * This reads the android app's api by default: `android-imm-v4.ws-app.com`, whose search answers a
 * place-filtered search over plain http with the app's own headers. No browser is opened, and the
 * app api does not rewrite the values.
 *
 * A pasted url is turned into that api's vocabulary by `lib/services/immobiliare/appApi.js`: a town
 * url resolves its place through the app's geography service, and a map url carries its own area. A
 * url the app api cannot express, or a refusal it cannot solve, falls back to the website path
 * below, which renders the page in the run's browser. Searches that only the website can express
 * therefore still work, and they cost a browser.
 *
 * The website path reads a town search from the page's `__NEXT_DATA__` and a map search from
 * `search-list/listings`, the endpoint the page calls once it is running. That endpoint is behind
 * DataDome and is answered by the browser, see `requestApiPage`. Both website shapes end in the same
 * payload as the app api, so one `normalize` reads either.
 */

import { buildHash, isOneOf, sleep, nullOrEmpty } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import { readNextData } from '../utils/priceExtractors.js';
import puppeteerExtractor, { newIsolatedPage } from '../services/extractor/puppeteerExtractor.js';
import { MAP_SEARCH_PATH, translateSearchUrl } from '../services/immobiliare/web-translator.js';
import { getAppListings, normalizeAppListing } from '../services/immobiliare/appApi.js';
import {
  advertIdInLink,
  fetchPropertyDetail,
  detailDescription,
  probeAdvertActivity,
} from '../services/immobiliare/propertyDetail.js';
import {
  captchaUrlIn,
  cookieParts,
  describeChallenge,
  isDataDomeBlock,
  isSolveable,
  readToken,
  tokenForBlock,
  SOLVE_USER_AGENT,
} from '../services/datadome.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.immobiliare.it/';

/** The react-query entry the search results live under, both in the page and at the endpoint. */
const LIST_QUERY_KEY = 'real-estate-list';

/** The endpoint that map search calls for its results. */
const LISTINGS_ENDPOINT_PATH = '/api-next/search-list/listings/';

/** The query parameter naming the result page, at the endpoint as on the page. */
const PAGE_PARAM = 'pag';

/** How many result pages one run reads, so a search covering a whole province cannot walk forever. */
const MAX_PAGES = 20;

/**
 * How long to wait between two result pages.
 *
 * The endpoint answers a token-bearing walk, but a walk that asks for twenty pages as fast as
 * the network allows is what earns the guard. The jitter keeps the gaps from being identical.
 */
const PAGE_DELAY_MS = 1_000;
const PAGE_JITTER_MS = 800;

/** How long one endpoint read may take in the browser, navigation included. */
const BROWSER_TIMEOUT_MS = 60_000;

/**
 * How many times one endpoint read is attempted, and how long it waits in between.
 *
 * A residential proxy drops a connection now and then, and a timeout costs a page rather than
 * refusing it, so one failed navigation must not end a walk of twenty.
 *
 * This is not what the `ERR_INVALID_AUTH_CREDENTIALS` in production was. That was every page
 * opened outside the default browser context reaching the proxy with no credentials at all, which
 * `newIsolatedPage` is what prevents; retrying it only bought the same refusal three times.
 *
 * Only a navigation that threw is attempted again. A status the endpoint chose is its answer, and
 * asking twenty pages again would be the walk the guard is watching for.
 */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 2_000;

/**
 * How many times a refused read is asked again from another proxy exit, before the solver is paid.
 *
 * The challenge follows the exit address. Measured in production 2026-09-17: the endpoint answers
 * `fe` from one residential exit and the listings from the next, several times an hour, with the
 * same browser and the same url. A new exit costs a navigation and a solve costs money, so the
 * address is changed first and capsolver is asked only once that ran out.
 *
 * Kept apart from {@link READ_ATTEMPTS}, which counts navigations that never arrived at all.
 */
const ROTATED_READS = 3;

/**
 * How the detail api stamps a property. Both are epoch **seconds** - the search endpoints this
 * provider reads answer in milliseconds or in display strings, so this is the one unit conversion
 * in the file - and `soldTransactionDate` is left alone, being about a sale that already happened.
 * @type {{created: string, modified: string}}
 */
const DETAIL_DATES = { created: 'creationDate', modified: 'lastModified' };

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
 * Ask the endpoint for one page of a search, inside the run's browser.
 *
 * The endpoint refuses a plain http client whatever its address. Measured 2026-09-15: `fetch` earns
 * a `bv` challenge from the datacenter ip and from nine residential exits alike, in IT, CH, DE and
 * FR, with the browser's own user agent and its headers, while the run's browser reads the same url
 * from the same exit node and is answered the listings. So the request has to be the browser's own.
 *
 * The browser is not enough on its own. Measured in production 2026-09-17: the endpoint answers the
 * browser 403 with a `fe` challenge, the kind capsolver solves, and it does so from some residential
 * exits and not from others. A refused read therefore has two remedies, tried in that order because
 * of what they cost:
 *
 * 1. another exit node, up to {@link ROTATED_READS} times. It costs a navigation, and it is the only
 *    remedy for `bv` and `it`, where the address itself is what is refused.
 * 2. a cookie from the solver, once, for a `fe` challenge. It costs money, so `tokenForBlock` caps
 *    it. The cookie is bound to the address that earned it, which is the configured exit, so the
 *    read carrying it goes back to the configured credentials.
 *
 * Both are for the guard alone. Any other refusal is the endpoint judging the parameters it was
 * sent, and it stands whatever address asks, so it ends the read at once as it always did.
 *
 * Each read is made in a browser context of its own. A context that has been sent to the website's
 * own search page carries that refusal over to the endpoint - measured: the page answers an
 * interstitial, and every later endpoint read in the same context answers one too - while a fresh
 * context costs nothing beyond the navigation that was going to happen anyway.
 *
 * @param {string} endpoint the endpoint url the search translates to
 * @param {number} page the page to read, counted from one
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<{results: any[], maxPages: number}|null>} the page, or null when it did not arrive
 */
async function requestApiPage(endpoint, page, browser) {
  const target = new URL(endpoint);
  target.searchParams.set(PAGE_PARAM, String(page));
  const host = target.host;

  // The first read of a run starts the clock a refusal is dated against.
  if (!browserFirstSeen.has(browser)) browserFirstSeen.set(browser, Date.now());

  // A cookie already solved for this host costs nothing to present, so the first read carries it.
  const stored = readToken(host);
  let read = { cookie: stored };
  let solverAsked = false;

  for (let refusals = 0; ; refusals++) {
    const answer = await readInBrowser(target, browser, page, read);
    // Not one navigation arrived. That is the network rather than the guard, and it is reported
    // where it happened.
    if (answer == null) return null;
    if (answer.status === 200) return searchPayload(answer.body);

    const refusal = await describeRefusal(answer, page, browser);

    // Only the guard is worth another address. Every other refusal is the endpoint's verdict on the
    // parameters it was sent - a 422 reads `{"errors":[{"message":"..."}]}` - and it would answer the
    // same from anywhere, so asking again only delays the fallback that renders the page instead.
    if (!isDataDomeBlock(answer.status, answer.body)) {
      logger.error(refusal);
      return null;
    }

    if (refusals < ROTATED_READS) {
      const remedy =
        read.freshExit && !answer.exitRotated
          ? 'Reading it again; the exit could not be rotated.'
          : 'Reading it again from another exit.';
      logger.warn(`${refusal} ${remedy}`);
      // The same short pause a retried navigation takes. The new exit answers at once; this only
      // keeps a refused walk from asking twice in the same instant.
      await sleep(READ_RETRY_MS);
      read = { freshExit: true };
      continue;
    }

    // Every exit was refused. Only a `fe` challenge can be bought back, and only once here; the
    // cooldown inside `tokenForBlock` is what keeps a walk of twenty pages to one solve.
    const challenge = captchaUrlIn(answer.body);
    if (!solverAsked && challenge != null && isSolveable(challenge)) {
      solverAsked = true;
      logger.warn(`${refusal} Asking the solver for a cookie.`);
      const solved = await tokenForBlock({
        status: answer.status,
        body: answer.body,
        host,
        userAgent: SOLVE_USER_AGENT,
        usedToken: stored,
      });
      if (solved != null) {
        read = { cookie: solved };
        continue;
      }
    }

    logger.error(refusal);
    return null;
  }
}

/**
 * What a refused read is worth knowing about beyond its body.
 *
 * The endpoint names what it refused - a 422 reads `{"errors":[{"message":"..."}]}` - and a 403 is
 * DataDome, whose body names the challenge instead. `describeChallenge` names that kind, because the
 * body alone does not show it.
 *
 * Which page of the walk was refused, and how old the browser was by then, are the other two. A
 * refusal on page one is a search that was never allowed; a refusal deep in a walk that has run past
 * the proxy's exit lifetime is the walk changing address mid-flight. The two want opposite remedies,
 * and the body says nothing about either.
 *
 * @param {{status: number, body: string, auth: any}} answer the refused answer
 * @param {number} page the page of the walk that was refused
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<string>} the line to log, at whatever level the caller has decided on
 */
async function describeRefusal(answer, page, browser) {
  const kind = describeChallenge(answer.body);
  const ageSeconds = Math.round((Date.now() - (browserFirstSeen.get(browser) ?? Date.now())) / 1000);
  const address = await exitAddress(browser, answer.auth);
  return (
    `Immobiliare.it answered ${answer.status}${kind} on page ${page} of the walk, ` +
    `${ageSeconds}s into the browser, from exit ${address}: ${answer.body.slice(0, 300)}`
  ).trimEnd();
}

/**
 * Read the search out of a body the endpoint answered 200 with.
 *
 * @param {string} body the answer's body
 * @returns {{results: any[], maxPages: number}|null} the page, or null when it carried no search
 */
function searchPayload(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    logger.error('Immobiliare.it answered 200 with something that is not the search payload.');
    return null;
  }
  if (!Array.isArray(payload?.results)) {
    logger.error('Immobiliare.it returned a payload without search results. The search URL may be wrong.');
    return null;
  }
  return { results: payload.results, maxPages: Number(payload.maxPages) || 1 };
}

/**
 * Read one url in the browser, asking again when the navigation never arrived.
 *
 * This counter is about the network alone. A residential proxy drops a connection now and then, and
 * a timeout costs a page rather than refusing it, so one failed navigation must not end a walk of
 * twenty. A status the endpoint chose is its answer and is handed back untouched: what to do about a
 * refusal is {@link requestApiPage}'s decision, and asking twenty pages again would be the walk the
 * guard is watching for.
 *
 * This is not what the `ERR_INVALID_AUTH_CREDENTIALS` in production was. That was every page opened
 * outside the default browser context reaching the proxy with no credentials at all, which
 * `newIsolatedPage` is what prevents; retrying it only bought the same refusal three times.
 *
 * @param {URL} target the url to read
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @param {number} page the page of the walk this read is for, for the log line
 * @param {{cookie?: string|null, freshExit?: boolean}} how the read is to be made
 * @returns {Promise<{status: number, body: string, auth: any, exitRotated: boolean}|null>} the
 *   answer, or null when no attempt reached the endpoint
 */
async function readInBrowser(target, browser, page, how) {
  let lastError = null;

  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(READ_RETRY_MS);
    try {
      return await navigateInOwnContext(target, browser, how);
    } catch (error) {
      lastError = error;
      // Chrome names the url it failed on, which here is the whole search; the message alone says
      // what went wrong.
      logger.warn(
        `Immobiliare.it: attempt ${attempt} of ${READ_ATTEMPTS} did not reach the endpoint ` +
          `on page ${page} of the walk (${String(error?.message ?? error)
            .split('\n')[0]
            .slice(0, 120)}).`,
      );
    }
  }

  logger.error(`Immobiliare.it could not be read in the browser: ${lastError?.message ?? lastError}`);
  return null;
}

/**
 * When each browser of a run was first used, so a refusal can say how old it is.
 *
 * The proxy holds one exit node for the `lifetime` its url asks for, five minutes in the deployed
 * setting. A walk that outlives that window presents the cookie it earned from a second address,
 * which is one of the things DataDome refuses. The age alone does not prove that happened, but a
 * refusal that always arrives after the same number of seconds says where to look.
 *
 * @type {WeakMap<import('puppeteer').Browser, number>}
 */
const browserFirstSeen = new WeakMap();

/**
 * The address the browser reaches the internet from, as the internet sees it.
 *
 * Read through the browser rather than through `fetch`, because the two need not share an exit: the
 * question is which address the refused request came from. Best effort by design - it is asked for
 * only when a read was already refused, so a failure here costs a line of a log entry and nothing
 * else.
 *
 * The credentials of the refused read are handed back in, because a rotated read left from an exit
 * of its own: asking the question with any other credentials would name an address that refused
 * nothing.
 *
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @param {{username: string, password: string}|null} [auth] the credentials the refused read used
 * @returns {Promise<string>} the address, or a short reason it could not be read
 */
async function exitAddress(browser, auth = null) {
  try {
    const answer = await navigateInOwnContext(new URL('https://api.ipify.org/?format=json'), browser, { auth });
    return JSON.parse(answer.body)?.ip ?? 'unknown';
  } catch (error) {
    return `unreadable (${String(error?.message ?? error)
      .split('\n')[0]
      .slice(0, 60)})`;
  }
}

/**
 * The domain a `datadome` cookie belongs to: the site, not the host the endpoint answers on.
 *
 * @param {URL} target the url about to be read
 * @returns {string} the cookie domain, `.immobiliare.it` for this provider
 */
function cookieDomain(target) {
  return `.${target.hostname.replace(/^www\./, '')}`;
}

/**
 * Navigate to one url in a browser context of its own, and answer what came back.
 *
 * @param {URL} target the url to read
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @param {object} [options]
 * @param {string|null} [options.cookie] a `datadome=...` cookie to set before navigating
 * @param {boolean} [options.freshExit] ask the proxy for an exit node it has not used yet
 * @param {{username: string, password: string}|null} [options.auth] credentials an earlier read was
 *   made with, so this one leaves from the same address
 * @returns {Promise<{status: number, body: string, auth: any, exitRotated: boolean}>} the answer,
 *   with the credentials it was made with and whether they were a rotation
 * @throws {Error} when the navigation itself failed - a dropped proxy, a timeout
 */
async function navigateInOwnContext(target, browser, { cookie = null, freshExit = false, auth = null } = {}) {
  // Through the extractor rather than `browser.createBrowserContext` directly: a page outside the
  // default context has to be told the proxy credentials, and the extractor is what knows them.
  const opened = await newIsolatedPage(browser, { freshExit, auth });
  const { page } = opened;

  try {
    if (cookie != null) {
      const { name, value } = cookieParts(cookie);
      await page.setCookie({ name, value, domain: cookieDomain(target), path: '/', secure: true });
    }
    const response = await page.goto(target.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_TIMEOUT_MS,
    });
    return {
      status: response?.status?.() ?? 0,
      body: await response.text(),
      auth: opened.auth ?? null,
      exitRotated: opened.exitRotated ?? false,
    };
  } finally {
    await page.close().catch(() => {});
    await opened.context.close().catch(() => {});
  }
}

/**
 * Read a search from the endpoint, one page at a time.
 *
 * @param {string} endpoint the endpoint url the search translates to
 * @param {number} from the first page to read, which is the second one for a town search
 * @param {number} [known] how many pages the search has, when the caller has already been told
 * @param {import('puppeteer').Browser} [browser] the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of every page read
 */
async function walkApi(endpoint, from, known, browser) {
  const results = [];
  let total = known ?? MAX_PAGES;

  for (let page = from; page <= Math.min(total, MAX_PAGES); page++) {
    if (page > from) await sleep(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);

    const answer = await requestApiPage(endpoint, page, browser);
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
 * @param {import('puppeteer').Browser} [browser] the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of every page the search has
 */
async function getListingsFromApi(url, browser) {
  return walkApi(convertMapSearchToApi(url), 1, undefined, browser);
}

/**
 * @param {string} url a town search url
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of every page the search has
 */
async function getListingsFromPage(url, browser) {
  logger.debug(`Immobiliare.it: ${url} has to be rendered; the endpoint cannot be asked for it.`);
  const rendered = await puppeteerExtractor(url, 'body', { browser, name: 'immobiliare' });
  const first = parseSearch(rendered);
  if (first == null) {
    logger.error('Immobiliare.it returned a page without search results. The search URL may be wrong.');
    return [];
  }
  // A page that names no criteria leaves nothing to ask the endpoint with, so it stands alone.
  if (first.criteria == null || first.maxPages <= 1) return first.results;

  const rest = await walkApi(convertTownSearchToApi(url, first.criteria), 2, first.maxPages, browser);
  return [...first.results, ...rest];
}

/**
 * @param {string} url the search url, with the sort parameter already appended
 * @param {import('puppeteer').Browser} browser the shared browser of the current job run
 * @returns {Promise<any[]>} the raw results of every page the search has
 */
async function getListings(url, browser) {
  // The app api answers a place filtered search over plain http, so a town or map search is tried
  // there first and costs no browser. A url it cannot express, or a refusal it cannot solve, falls
  // through to the website path below rather than answering with a wider search. An empty answer is
  // the api's own verdict on a search that matched nothing, so it is returned as it stands: the
  // website path would only render the same empty page behind a bot wall.
  const fromAppApi = await getAppListings(url);
  if (fromAppApi != null) return fromAppApi;

  if (new URL(url).pathname === MAP_SEARCH_PATH) return getListingsFromApi(url, browser);

  const criteria = await translateSearchUrl(url);
  if (criteria != null) {
    const endpoint = convertTownSearchToApi(url, criteria);
    const first = await requestApiPage(endpoint, 1, browser);
    // The endpoint is the judge of its own parameters, and it refuses a filter whose value is not
    // in the shape it expects rather than ignoring it. A refusal is therefore a url this could not
    // read after all, and the page still can - answering nothing would be the one wrong move.
    if (first != null) {
      const rest = first.maxPages > 1 ? await walkApi(endpoint, 2, first.maxPages, browser) : [];
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
  // The app api answers a flat item; the website nests the same advert under `realEstate`. One
  // normalizer per shape, chosen on the field only one of them carries.
  if (o?.realEstate == null && (o?.topology != null || o?.geography != null)) return normalizeAppListing(o);
  return normalizeWebsite(o);
}

/**
 * @param {any} o one entry of the website search payload
 * @returns {ParsedListing}
 */
function normalizeWebsite(o) {
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
    // A search read from the rendered page carries the text, one read from the endpoint does not -
    // there the advert is fetched whole in fetchDetails, which is also what the stored rows the
    // description sweep fills from.
    description: property.description ?? null,
    image: property.photo?.urls?.large ?? property.photo?.urls?.medium ?? property.photo?.urls?.small,
  };
}

/**
 * Read what the search payload does not carry out of the android app's property detail.
 *
 * The search endpoints answer no dates and no description - read an advert whole and there is
 * nothing to find - while the app's detail carries `creationDate`, `lastModified` and the text.
 * The portal's own "pubblicato il" is the creation; a listing re-published to the top of the search
 * is what `lastModified` moves for, so the later of the two is what the listing list should order
 * by. The description is only filled in, never overwritten: a search read from the rendered page
 * already carries the text, and it is the same text the app would answer with.
 *
 * One request per *new* listing: the pipeline enriches only what it has not stored yet, so a run
 * that finds nothing new costs nothing at all.
 *
 * @param {ParsedListing} listing The listing to attach the date and the description to.
 * @returns {Promise<ParsedListing>} The same listing, with `publishedAt` and a description when the
 *   api answered with them.
 */
async function fetchDetails(listing) {
  const id = advertIdInLink(listing?.link);
  if (id == null) return listing;

  const detail = await fetchPropertyDetail(id);
  if (detail == null) return listing;

  const seconds = Math.max(Number(detail?.[DETAIL_DATES.created]) || 0, Number(detail?.[DETAIL_DATES.modified]) || 0);
  if (seconds > 0) listing.publishedAt = seconds * 1000;
  // A description that came with the search stands; the api's word is only asked for when the
  // payload had none, which is every search the endpoint answered.
  if (nullOrEmpty(listing.description)) {
    const description = detailDescription(detail);
    if (description != null) listing.description = description;
  }
  return listing;
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
  // ?prezzoMinimo=500&prezzoMassimo=1000 - the same two names the search endpoint takes.
  priceRangeParams: { min: 'prezzoMinimo', max: 'prezzoMassimo' },
  // The detail reads ride the app api at the gait the description sweep already keeps against it.
  detailFetchDelayMs: 400,
  detailFetchJitterMs: 300,
  // Both: the app api answers one advert with its dates and its text at once, and `fetchDetails`
  // above writes each of them onto the listing when the payload carried it.
  detailFields: ['description', 'publishedAt'],
  getListings,
  normalize,
  fetchDetails,
  activityProbe: probeAdvertActivity,
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
