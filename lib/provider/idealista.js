/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Idealista.it, the Italian arm of the Spanish portal.
 *
 * DataDome guards the whole site and answers the first request of any client with a 403 and a
 * small interstitial. Clearing it takes a browser with a head on it: a headless one runs the same
 * script and stays on the 1.5 kB block page however long it is given. Fredy's own browser is
 * headless, so it cannot do this, and running a headful one would need a display Fredy has no
 * business requiring.
 *
 * So the wall is cleared elsewhere. `FREDY_CHALLENGE_SOLVER_URL` names a challenge-solving scrape
 * service - TRAWL, or anything that answers the same shape - which renders the page and hands
 * back the `datadome` cookie it earned. Without that variable this provider finds nothing and
 * says so; it never falls back to a browser.
 *
 * That cookie is the whole session. Carrying it, a plain `fetch` reads any search page, including
 * one the solver never opened, so the service is called once and every ordinary run afterwards is
 * a plain request.
 *
 * Two consequences shape the code below. DataDome rotates the cookie on every response, so each
 * reply's `Set-Cookie` has to replace the stored value or the next request presents a stale one.
 * And because the value rotates, requests are serialized: two in flight together overwrite each
 * other's rotation and both lose it.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.idealista.it';
const ACCEPT_LANGUAGE = 'it-IT,it;q=0.9,en;q=0.8';
const LISTING_SELECTOR = 'article.item';
const COOKIE_NAME = 'datadome';

/** How long the solver is given to clear the wall. It renders a page and may escalate tiers. */
const SOLVER_TIMEOUT_MS = 90_000;

/** Used until the solver has minted a session, whose own user agent then replaces it. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * The cookie and the user agent it was minted with, which DataDome checks against each other.
 *
 * Kept in the process rather than in the database: a restart costs one call to the solver, and a
 * cookie that outlives the process buys little because DataDome rotates it away on every request
 * anyway.
 */
let session = null;

/** Requests are chained through this so no two of them race for the cookie's next value. */
let pending = Promise.resolve();

/**
 * Run a task after every task already queued, whether those failed or not.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serialize(task) {
  const result = pending.then(task, task);
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * @param {number} status
 * @param {string} body
 * @returns {boolean} whether DataDome answered instead of the portal
 */
function isWall(status, body) {
  return status === 403 || /captcha-delivery/i.test(body);
}

/**
 * Read the rotated cookie off a response and keep it.
 *
 * @param {Response} response
 * @returns {void}
 */
function absorbRotation(response) {
  // Only a verified session is worth following. A wall sets this cookie too, and that value is
  // the unsolved one.
  if (session == null) return;

  const rotated = response.headers
    ?.getSetCookie?.()
    ?.find((entry) => entry.startsWith(`${COOKIE_NAME}=`))
    ?.split(';')[0]
    ?.slice(COOKIE_NAME.length + 1);
  if (rotated) {
    session.cookie = rotated;
  }
}

/**
 * Read a solver's answer, whichever of the two shapes it uses.
 *
 * TRAWL's own `/scrape` returns the fields at the top level. The FlareSolverr `/v1` shape, which
 * TRAWL and its alternatives also speak, nests them under `solution` and names the page
 * `response`. Reading both costs a few lines and lets this provider work against whichever
 * service is already running.
 *
 * @param {any} payload the decoded response body
 * @returns {{html: string, cookies: any[], userAgent: string|undefined}|null}
 */
function readSolverAnswer(payload) {
  const solution = payload?.solution ?? payload;
  const html = solution?.html ?? solution?.response;
  if (typeof html !== 'string' || html.length === 0) return null;
  return {
    html,
    cookies: Array.isArray(solution?.cookies) ? solution.cookies : [],
    userAgent: typeof solution?.userAgent === 'string' ? solution.userAgent : undefined,
  };
}

/**
 * Ask the configured solver to clear the wall, and keep the session it earned.
 *
 * The rendered page comes back with the cookie, so it is returned too: the solver had to load the
 * search anyway, and reading the adverts off that render saves repeating the request.
 *
 * @param {string} url the search url
 * @returns {Promise<string|null>} the rendered page, or null when the wall did not clear
 */
async function mintSession(url) {
  const endpoint = process.env.FREDY_CHALLENGE_SOLVER_URL?.trim();
  if (!endpoint) {
    logger.error(
      'Idealista is behind DataDome, which needs a challenge-solving scrape service. Set ' +
        'FREDY_CHALLENGE_SOLVER_URL to one (e.g. http://trawl:8191/scrape) or disable this provider.',
    );
    return null;
  }

  logger.debug(`Idealista: no usable session, asking ${endpoint} to clear the wall.`);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: SOLVER_TIMEOUT_MS }),
      signal: AbortSignal.timeout(SOLVER_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.error(`Idealista: the solver answered ${response.status} ${response.statusText}.`);
      return null;
    }

    const answer = readSolverAnswer(await response.json());
    if (answer == null) {
      logger.error('Idealista: the solver returned no page.');
      return null;
    }

    const cookie = answer.cookies.find((entry) => entry?.name === COOKIE_NAME)?.value;
    if (cookie == null) {
      logger.error('Idealista: the solver returned a page but no datadome cookie, so nothing can be reused.');
      return null;
    }

    session = { cookie, userAgent: answer.userAgent ?? DEFAULT_USER_AGENT };
    return answer.html;
  } catch (error) {
    logger.error('Idealista: the solver did not get past DataDome.', error);
    return null;
  }
}

/**
 * Request a search page, carrying the session when there is one.
 *
 * The request is made even without a session. That first one is expected to wall, and paying for
 * it keeps one path through this provider instead of two - and it is what notices the day
 * idealista serves a plain request again.
 *
 * @param {string} url
 * @returns {Promise<{status: number, body: string}>}
 */
async function requestPage(url) {
  const headers = {
    'User-Agent': session?.userAgent ?? DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': ACCEPT_LANGUAGE,
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
  };
  if (session != null) {
    headers.Cookie = `${COOKIE_NAME}=${session.cookie}`;
  }

  const response = await fetch(url, { headers, redirect: 'follow' });
  absorbRotation(response);
  return { status: response.status, body: await response.text() };
}

/**
 * Read the adverts out of a rendered search page.
 *
 * @param {string|null|undefined} html the raw html of a search result page
 * @returns {any[]} the raw adverts, empty when the page carried none
 */
export function parseListings(html) {
  if (html == null) return [];
  const $ = cheerio.load(html);

  return $(LISTING_SELECTOR)
    .map((_, element) => {
      const card = $(element);
      // The freshness marker ("2 minuti", "20 ago") sits in this list next to the real
      // characteristics, so each field is matched by shape rather than by position.
      const characteristics = card
        .find('.item-detail-char .item-detail')
        .map((__, detail) => $(detail).text().trim())
        .get();

      return {
        id: card.attr('data-element-id'),
        title: card.find('a.item-link').attr('title'),
        href: card.find('a.item-link').attr('href'),
        price: card.find('.item-price').first().text().trim(),
        characteristics,
        description: card.find('.item-description').first().text().trim(),
        image: card.find('img').first().attr('src'),
      };
    })
    .get();
}

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
 * @param {any} o one card of the search page
 * @returns {ParsedListing}
 */
function normalize(o) {
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
 * @param {string} url the search url
 * @returns {Promise<any[]>} the adverts of the first result page
 */
async function getListings(url) {
  return serialize(async () => {
    const { status, body } = await requestPage(url);
    if (!isWall(status, body)) return parseListings(body);

    logger.debug(`Idealista answered with a wall (${status}); asking the solver to clear it.`);
    session = null;

    const rendered = await mintSession(url);
    if (rendered == null) {
      logger.error('Idealista returned a wall that was not cleared, so this run found nothing.');
      return [];
    }
    return parseListings(rendered);
  });
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
  // The adverts are read out of the cards by `getListings`, so the generic crawler has no work.
  crawlContainer: null,
  crawlFields: {},
  // Idealista's robots.txt disallows `/*?ordine=pubblicazione-desc`, which is the sort this would
  // ask for. Like tecnocasa, the search therefore runs in the portal's own order. Keep an
  // idealista search narrow enough that a new advert reaches the first page.
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
