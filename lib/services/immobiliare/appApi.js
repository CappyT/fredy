/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The android app's own search api, and the translation a website search url needs to reach it.
 *
 * `GET https://android-imm-v4.ws-app.com/b2c/v1/properties` answers a search with plain HTTP and no
 * credentials: an app user agent and four more headers are enough. That is what lets a place
 * filtered search - a town, a province, a region, a drawn area - cost no browser at all, where the
 * website endpoint refuses a plain client with a `bv` challenge whatever the exit address.
 *
 * This module owns three things and nothing else:
 *
 * - `buildAppSearch` reads a search url into the app api's own parameter vocabulary. The place the
 *   url names is resolved through the app's geography service (see `./geography.js`), the filters
 *   the app api accepts are translated, and the sort is pinned to `of=d&od=d` (newest first).
 * - `fetchAppPage` and `getAppListings` page the search by `start`, a page holding twenty.
 * - `normalizeAppListing` reads the app's flat item (`id`, `title`, `price`, `analytics`,
 *   `geography`, `contract`, `topology`, `media`) into the same `ParsedListing` the website payload
 *   produces - including the dates, which travel in the search item here.
 *
 * The app api ignores a parameter it does not know, in silence, so a translation that guessed wrong
 * would widen somebody's search rather than fail. `buildAppSearch` therefore answers `null` for a
 * url carrying a filter it cannot translate, and the provider falls back to the website path for
 * that url. Only known filters are sent. The api also refuses a value it cannot read with a 400, so
 * a url it cannot express faithfully - several places under one filter, say - is refused here and
 * rendered instead of being narrowed by half.
 *
 * A 403 is the DataDome guard, whose challenge depends on the exit. A solvable `fe` challenge is
 * bought once and its cookie reused; a challenge the solver cannot answer falls back to the browser.
 *
 * See `reverse-engineered-immobiliare.md` for the measured vocabulary.
 */

import { randomUUID } from 'node:crypto';
import { buildHash, sleep } from '../../utils.js';
import { extractNumber } from '../../utils/extract-number.js';
import logger from '../logger.js';
import { captchaUrlIn, isDataDomeBlock, isSolveable, readToken, tokenForBlock, SOLVE_USER_AGENT } from '../datadome.js';
import { MAP_SEARCH_PATH, translateSearchUrl } from './web-translator.js';
import { USER_AGENT } from './userAgent.js';
/** @import { ParsedListing } from '../../types/listing.js' */

/** The host the android app talks to. Unrelated to www.immobiliare.it, and behind DataDome. */
const APP_HOST = 'https://android-imm-v4.ws-app.com';

/** The same host as the datadome token store keys it, so a solved cookie can be reused here. */
const APP_HOSTNAME = new URL(APP_HOST).host;

/** The search resource. One page is twenty adverts. */
const SEARCH_PATH = '/b2c/v1/properties';

/** How many adverts one page holds, as measured. */
export const PAGE_SIZE = 20;

/**
 * How long a search page may be waited for. The same order as the other plain clients in the
 * repository: a bare `fetch` has no timeout of its own, and a host that accepts the connection and
 * then says nothing would hold a job run open for as long as the socket lives.
 */
const REQUEST_TIMEOUT = 15000;

/**
 * The identity the app sends as `immo-id`: one uuid per install. The api answers without it, but a
 * client that wears the app's whole header set is the one a bot guard is meant to pass.
 */
const IMMO_ID = randomUUID();

/**
 * How long to wait between two search pages, and the jitter that keeps the gaps from being
 * identical. A walk of twenty pages asked for as fast as the network allows is what earns a guard.
 */
const PAGE_DELAY_MS = 1_000;
const PAGE_JITTER_MS = 800;

/** The link the portal serves an advert on. The app names no link, so it is built from the id. */
const ADVERT_LINK_PREFIX = 'https://www.immobiliare.it/annunci/';

/**
 * The url filters the app api reads, by the name the website spells them with. Every value here is
 * a number, so a translation cannot silently change what the filter means.
 */
const FILTER_PARAM = {
  prezzoMinimo: 'pm',
  prezzoMassimo: 'px',
  superficieMinima: 'sm',
  superficieMassima: 'sx',
  localiMinimo: 'lm',
  localiMassimo: 'lx',
};

/** The terms of the offer, which the website writes as an id and the app as a token. */
const CONTRACT_VALUE = { 1: 'v', 2: 'a' };

/**
 * The place, by the level the geography service tags it with. The website and the app name the
 * levels differently, so each is translated here rather than passed through.
 */
const SCOPE_PARAM = {
  'idMZona[]': 'z2',
  idComune: 'c',
  idProvincia: 'pr',
  fkRegione: 'regionId',
  idNazione: 'nationId',
};

/** Most specific first, which is the one scope a request carries. */
const SCOPE_PRIORITY = ['z2', 'c', 'pr', 'regionId', 'nationId'];

/**
 * Parameters that belong to the request rather than to the search: the sort and the page, which
 * this module sets itself, and the language, which the app api reads from `accept-language`.
 */
const DROPPED = new Set(['criterio', 'ordine', 'pag', '__lang']);

/**
 * Turn a website viewport rectangle into the app's `points` polygon.
 *
 * The website spells the rectangle `lat,lng;lat,lng` - two opposite corners - and the app wants a
 * closed polygon, so the rectangle is expanded to its four corners. A url that already carries a
 * polygon (three or more pairs) travels through untouched. A shape that does not read as coordinate
 * pairs - the app's own `;`/`|` spelling, a form this has not measured - is refused rather than
 * guessed at, and the caller renders the page instead.
 *
 * @param {string|null|undefined} vrt the `vrt` parameter of a map search url
 * @returns {string|null} the `points` value, or null when it does not read as coordinate pairs
 */
export function pointsFromVrt(vrt) {
  if (typeof vrt !== 'string' || vrt.trim().length === 0) return null;
  const points = vrt.replace(/\|/g, ' ').replace(/;/g, ' ').trim();
  const pairs = points.split(/\s+/);
  const pair = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;
  if (!pairs.every((value) => pair.test(value))) return null;

  if (pairs.length === 2) {
    const [first, second] = pairs.map((value) => value.split(','));
    const [lat1, lng1] = first;
    const [lat2, lng2] = second;
    return [`${lat1},${lng1}`, `${lat1},${lng2}`, `${lat2},${lng2}`, `${lat2},${lng1}`].join(' ');
  }
  return pairs.length >= 3 ? pairs.join(' ') : null;
}

/**
 * Read the parameters of a search url into the app api's own vocabulary.
 *
 * @param {Array<[string, string]>} pairs the url's parameters, as `[name, value]` in the order they
 *   appeared
 * @returns {URLSearchParams|null} the app api query without `start`, or null when the url names a
 *   filter or a shape this cannot translate
 */
function assemble(pairs) {
  const params = new URLSearchParams();
  /** @type {Record<string, string>} */
  const scope = {};
  let contract = null;
  let category = null;
  /** @type {string[]} */
  const typologies = [];

  for (const [name, value] of pairs) {
    if (name === 'vrt') {
      const points = pointsFromVrt(value);
      if (points == null) return null;
      scope.points = points;
      continue;
    }
    if (DROPPED.has(name)) continue;

    if (name === 'idContratto') {
      const token = CONTRACT_VALUE[String(value)];
      if (token == null) return null;
      contract = token;
    } else if (name === 'idCategoria') {
      category = String(value);
    } else if (name === 'idTipologia[]') {
      typologies.push(String(value));
    } else if (SCOPE_PARAM[name] != null) {
      const level = SCOPE_PARAM[name];
      // The api reads one value per place filter: `z2=a&z2=b` answers 400, and `z2=a,b` reads as one
      // unknown id and matches nothing. A url naming several quarters therefore cannot be expressed,
      // and keeping only the last would silently narrow the search - the one wrong outcome.
      if (scope[level] != null) return null;
      scope[level] = String(value);
    } else if (FILTER_PARAM[name] != null) {
      params.append(FILTER_PARAM[name], String(value));
    } else {
      // A filter this does not know. Sending the url without it would search wider than the user
      // asked for, which is the one wrong outcome, so the caller falls back to the website.
      return null;
    }
  }

  // The api answers 400 without a geo scope, and the website endpoint refuses one without a contract.
  if (contract == null) return null;

  const narrowed = SCOPE_PRIORITY.find((level) => scope[level] != null);
  if (narrowed == null && scope.points == null) return null;
  // A drawn area and a place named together are an intersection on the website, and the api takes
  // one scope per request. Sending the area alone would answer beyond the drawn place, so the url is
  // refused and the caller renders it.
  if (narrowed != null && scope.points != null) return null;

  params.set('t', contract);
  if (category != null) params.set('cat', category);
  // The api refuses a repeated `tip` (400, "querystring/tip must be string") and reads a
  // comma-joined list as several typologies, which is what the website's repeated `idTipologia[]`
  // means. Sending them one by one would cost a browser for a search the api can express.
  if (typologies.length > 0) params.set('tip', typologies.join(','));
  if (scope.points != null) params.set('points', scope.points);
  else params.set(narrowed, scope[narrowed]);

  // The website sorts by `criterio=data&ordine=desc`; the app api's own newest-first sort.
  params.set('of', 'd');
  params.set('od', 'd');
  return params;
}

/**
 * Build the app api call a pasted website search url stands for.
 *
 * @param {string} webUrl A url copied out of immobiliare.it.
 * @returns {Promise<URLSearchParams|null>} the query the app api searches by, without `start`, or
 *   null when the url cannot be expressed to it
 */
export async function buildAppSearch(webUrl) {
  let parsed;
  try {
    parsed = new URL(webUrl);
  } catch {
    return null;
  }

  if (parsed.pathname === MAP_SEARCH_PATH) return assemble([...parsed.searchParams]);

  // A town names its place in the path, so the search is read whole: category, place and filters.
  const criteria = await translateSearchUrl(webUrl);
  if (criteria == null) return null;
  return assemble(criteria);
}

/**
 * Read a response body as text, answering an empty string when it cannot be read.
 *
 * @param {Response} answer the response
 * @returns {Promise<string>} the body, or an empty string
 */
async function bodyOf(answer) {
  try {
    return await answer.text();
  } catch {
    return '';
  }
}

/**
 * Name the DataDome challenge a blocked body carries, for the log.
 *
 * The body alone does not show it: the `t` value sits at the end of a url longer than any log line
 * keeps. Its two values want opposite remedies. `fe` is the kind capsolver solves; `it` and `bv`
 * are not, and the provider renders the website instead.
 *
 * @param {string} body the blocked response body
 * @returns {string} a ` (DataDome <kind>, <verdict>)` suffix, or an empty string when there is none
 */
function challengeKind(body) {
  const challenge = captchaUrlIn(body);
  if (challenge == null) return '';
  try {
    const kind = new URL(challenge).searchParams.get('t');
    const verdict = isSolveable(challenge) ? 'solvable' : 'not solvable, the exit is refused';
    return ` (DataDome ${kind}, ${verdict})`;
  } catch {
    return '';
  }
}

/**
 * Ask the app api for one page of a search.
 *
 * The api carries a DataDome guard whose challenge depends on the exit: measured 2026-09-16, one
 * Italian residential exit answered 200, another answered 403 with the `it` interstitial, and a
 * datacenter exit answered 403 with the `fe` challenge. `fe` is the kind capsolver solves, so a
 * stored token is reused and a `fe` challenge is offered to the solver before the provider gives up
 * and renders the website. A challenge the solver cannot answer, or a deployment with no solver,
 * falls back to the browser. `lib/services/datadome.js` owns the solve and its cost cap.
 *
 * @param {URLSearchParams} params the query {@link buildAppSearch} produced
 * @param {number} start the offset of the page, a page holding {@link PAGE_SIZE}
 * @returns {Promise<{items: any[], totalActive: number}|null>} the page, or null when the api
 *   refused or answered nothing readable
 */
export async function fetchAppPage(params, start) {
  const target = new URL(SEARCH_PATH, APP_HOST);
  for (const [name, value] of params) target.searchParams.append(name, value);
  target.searchParams.set('start', String(start));

  const send = (cookie) =>
    fetch(target, {
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'it-IT',
        'x-currency': 'EUR',
        'x-measurement-unit': 'meters',
        'immo-id': IMMO_ID,
        accept: 'application/json',
        ...(cookie == null ? {} : { cookie }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

  const known = readToken(APP_HOSTNAME);
  let answer;
  try {
    answer = await send(known);
  } catch (error) {
    logger.warn(`Immobiliare.it: the app api could not be read (${error?.message ?? error}).`);
    return null;
  }

  if (answer.status === 403) {
    const blocked = await bodyOf(answer);
    if (!isDataDomeBlock(answer.status, blocked)) {
      logger.warn(`Immobiliare.it: the app api answered ${answer.status} for the search, rendering instead.`);
      return null;
    }
    const solved = await tokenForBlock({
      status: answer.status,
      body: blocked,
      host: APP_HOSTNAME,
      userAgent: SOLVE_USER_AGENT,
      usedToken: known,
    });
    if (solved == null) {
      logger.warn(
        `Immobiliare.it: the app api answered 403${challengeKind(blocked)} for the search, rendering instead.`,
      );
      return null;
    }
    try {
      answer = await send(solved);
    } catch (error) {
      logger.warn(`Immobiliare.it: the app api could not be read with a token (${error?.message ?? error}).`);
      return null;
    }
  }

  if (!answer.ok) {
    logger.warn(`Immobiliare.it: the app api answered ${answer.status} for the search, rendering instead.`);
    return null;
  }

  let payload;
  try {
    payload = await answer.json();
  } catch {
    logger.error('Immobiliare.it: the app api answered 200 with something that is not the search payload.');
    return null;
  }

  const items = Array.isArray(payload?.list) ? payload.list : null;
  if (items == null) {
    logger.error('Immobiliare.it: the app api returned a payload without search items.');
    return null;
  }
  return { items, totalActive: Number(payload.totalActive) || items.length };
}

/**
 * Read every page of an app api search.
 *
 * @param {string} webUrl the website search url
 * @param {number} [maxPages] how many pages one run reads, so a whole province cannot walk forever
 * @returns {Promise<any[]|null>} the raw items of every page read, or null when the url cannot be
 *   expressed to the app api or the first page was refused
 */
export async function getAppListings(webUrl, maxPages = 20) {
  const params = await buildAppSearch(webUrl);
  if (params == null) return null;

  const first = await fetchAppPage(params, 0);
  if (first == null) return null;

  const results = [...first.items];
  const total = Math.ceil(first.totalActive / PAGE_SIZE);
  let pages = Math.min(Math.max(total, 1), maxPages);

  for (let page = 1; page < pages; page++) {
    await sleep(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);
    const next = await fetchAppPage(params, page * PAGE_SIZE);
    if (next == null) break;
    results.push(...next.items);
    pages = Math.min(Math.max(Math.ceil(next.totalActive / PAGE_SIZE), 1), maxPages);
  }

  if (total > maxPages) {
    logger.warn(`Immobiliare.it: stopped after ${maxPages} pages. Narrow the search to see the rest.`);
  }
  return results;
}

/**
 * Build the title the website shows an advert under, from the parts the app item carries.
 *
 * The app answers the typology alone ("Appartamento") where the website composes
 * "Appartamento via San Francesco d'Assisi 11, Quadronno - Crocetta, Milano" out of the same fields.
 * Composing it here keeps a title useful for the blacklist and the notification.
 *
 * @param {any} item one app search item
 * @returns {string|null} the title, or null when the item names nothing
 */
function buildTitle(item) {
  const topology = item?.topology ?? {};
  const geography = item?.geography ?? {};
  const head = [topology?.typology?.name, geography?.street].filter(Boolean).join(' ');
  const zone = geography?.microzone?.name ?? geography?.macrozone?.name;
  const city = geography?.municipality?.name;
  const composed = [head, zone, city].filter((part) => typeof part === 'string' && part.length > 0).join(', ');
  return composed.length > 0 ? composed : (item?.title ?? null);
}

/**
 * Build the address shown on the listing, from the street and the town the app item carries.
 *
 * @param {any} geography one app item's `geography` object
 * @returns {string|null} the address, or null when the item names no place at all
 */
function buildAddress(geography) {
  const parts = [geography?.street, geography?.municipality?.name].filter(
    (part) => typeof part === 'string' && part.trim().length > 0,
  );
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * The moment the portal considers the advert to have appeared. Both figures are epoch seconds, and
 * the later of the two is the portal's own notion of "newer": a re-published advert moves
 * `lastModified`.
 *
 * @param {any} item one app search item
 * @returns {number|undefined} the timestamp in milliseconds, or undefined when the item carries none
 */
function buildPublishedAt(item) {
  const seconds = Math.max(Number(item?.creationDate) || 0, Number(item?.lastModified) || 0);
  return seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Read one app search item into the `ParsedListing` the website payload produces.
 *
 * The item is flat where the website item nests everything under `realEstate`, so this is a
 * normalizer of its own rather than a branch of the website one.
 *
 * @param {any} item one entry of the app search payload
 * @returns {ParsedListing}
 */
export function normalizeAppListing(item) {
  const topology = item?.topology ?? {};
  const geography = item?.geography ?? {};
  const geolocation = geography?.geolocation ?? {};
  // An advert whose owner asked for the price to stay hidden carries the flag but no figure.
  const price = item?.price?.isHidden === true ? null : item?.price?.raw;
  const id = item?.id;
  const image = Array.isArray(item?.media?.images) ? item.media.images[0] : null;

  return {
    id: buildHash(String(id ?? ''), price == null ? null : String(price)),
    title: buildTitle(item),
    link: id == null ? null : `${ADVERT_LINK_PREFIX}${id}/`,
    price: extractNumber(price),
    size: extractNumber(topology?.surface?.size),
    rooms: extractNumber(topology?.rooms),
    address: buildAddress(geography),
    latitude: geolocation?.latitude,
    longitude: geolocation?.longitude,
    description: null,
    image: image?.hd ?? image?.sd,
    publishedAt: buildPublishedAt(item),
  };
}
