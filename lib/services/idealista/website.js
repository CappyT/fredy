/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Reads an idealista search off the website, which is what happens when the mobile api cannot be
 * asked for it - see `./search.js` for when that is.
 *
 * A bot wall that no headless browser clears sits in front of every page, so
 * `FREDY_CHALLENGE_SOLVER_URL` names an external scrape service that renders the page and returns
 * the `datadome` cookie it earned. That cookie is the session: carrying it, a plain request reads
 * any search page, so the service is called only when there is no working one.
 *
 * The cookie rotates on every response, so each reply's `Set-Cookie` replaces the stored value, and
 * requests are serialized to stop two in flight overwriting each other's rotation.
 *
 * A run reads the whole result set rather than the first page of it. The website serves no ordering
 * Fredy may ask for - its robots.txt disallows the publication sort - so a new advert lands wherever
 * the portal's own ranking puts it, which on a wide search is rarely the first page. The api has no
 * such rule, which is the main reason to prefer it.
 */

import * as cheerio from 'cheerio';
import { challengeSolverUrl, solveChallenge } from '../extractor/challengeSolver.js';
import logger from '../logger.js';

const ACCEPT_LANGUAGE = 'it-IT,it;q=0.9,en;q=0.8';
const LISTING_SELECTOR = 'article.item';
const COOKIE_NAME = 'datadome';

/** Adverts on a full result page, which is what tells the last page from the ones before it. */
const PAGE_SIZE = 30;

/** How many result pages one run reads, so a search covering a whole region cannot walk forever. */
const MAX_PAGES = 20;

/**
 * How long to wait between two result pages.
 *
 * DataDome reads the pace as well as the client: a walk that turns the pages as fast as the network
 * allows earns a captcha the solver cannot clear, and the address stays blocked for hours. Ten
 * pages a second apart was enough to trigger it, so the gap is the one a reader would leave. The
 * jitter keeps the gaps from being identical, which is its own signal.
 */
const PAGE_DELAY_MS = 3_500;
const PAGE_JITTER_MS = 2_500;

/** The suffix the paginator appends for every page after the first, `.htm` or not. */
const PAGE_SUFFIX = /\/lista-\d+(\.htm)?$/;

/**
 * A search over an area drawn on the map, whose pages the paginator names without the `.htm` -
 * `/aree/vendita-case/lista-2?shape=...`. Asked with the suffix the other searches use, the portal
 * answers a page with no adverts on it, and the walk would end at the first page.
 */
const DRAWN_PATH = /^\/(?:[a-z]{2}\/)?aree\//;

/** Used until the solver has minted a session, whose own user agent then replaces it. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * The cookie and the user agent it was minted with, which are checked against each other.
 *
 * In the process rather than the database: a restart costs one call to the solver, and the value
 * rotates away on every request anyway.
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
 * What the portal answers a client that has asked for too much, too fast. It is not a wall: no
 * session clears it and the solver has nothing to solve, so the run stops and leaves the rest of
 * the search to the next one.
 */
const TOO_MANY_REQUESTS = 429;

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
 * Ask the configured solver to clear the wall, and keep the session it earned.
 *
 * Its render is returned too, because it loaded the search anyway.
 *
 * @param {string} url the search url
 * @returns {Promise<string|null>} the rendered page, or null when the wall did not clear
 */
async function mintSession(url) {
  if (challengeSolverUrl() == null) {
    logger.error(
      'Idealista is behind DataDome, which needs a challenge-solving scrape service. Set ' +
        'FREDY_CHALLENGE_SOLVER_URL to one (e.g. http://trawl:8191/scrape) or disable this provider.',
    );
    return null;
  }

  const answer = await solveChallenge(url, 'Idealista');
  if (answer == null) return null;

  const cookie = answer.cookies.find((entry) => entry?.name === COOKIE_NAME)?.value;
  if (cookie == null) {
    logger.error('Idealista: the solver returned a page but no datadome cookie, so nothing can be reused.');
    return null;
  }

  session = { cookie, userAgent: answer.userAgent ?? DEFAULT_USER_AGENT };
  return answer.html;
}

/**
 * Request a search page, carrying the session when there is one.
 *
 * It runs without a session too. That first request is expected to wall, but it keeps one path
 * through this provider instead of two.
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
 * Address one page of a search.
 *
 * The paginator hangs the page off the search path, so a url already naming a page is rewritten
 * rather than appended to.
 *
 * @param {string} url the search url
 * @param {number} page the page to read, counted from one
 * @returns {string} the url of that page
 */
export function pageUrl(url, page) {
  const parsed = new URL(url);
  const search = parsed.pathname.replace(PAGE_SUFFIX, '/');
  const suffix = DRAWN_PATH.test(search) ? `lista-${page}` : `lista-${page}.htm`;
  parsed.pathname = page <= 1 ? search : `${search.replace(/\/+$/, '')}/${suffix}`;
  return parsed.toString();
}

/**
 * @returns {Promise<void>} a wait of one jittered page delay
 */
function pause() {
  return new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS));
}

/**
 * Read one result page, clearing the wall in front of it when there is one.
 *
 * @param {string} url the url of the page
 * @returns {Promise<any[]|null>} the adverts on it, empty when the wall stayed up, null when the
 *   portal asked for the requests to stop
 */
async function readPage(url) {
  const { status, body } = await requestPage(url);
  if (status === TOO_MANY_REQUESTS) {
    logger.warn('Idealista answered 429: too many requests. The rest of this search waits for the next run.');
    return null;
  }
  if (!isWall(status, body)) return parseListings(body);

  logger.debug(`Idealista answered with a wall (${status}); asking the solver to clear it.`);
  session = null;

  const rendered = await mintSession(url);
  if (rendered == null) {
    logger.error('Idealista returned a wall that was not cleared, so this run found nothing.');
    return [];
  }
  return parseListings(rendered);
}

/**
 * Read every result page a search spreads over.
 *
 * @param {string} url the search url
 * @returns {Promise<any[]>} the adverts of every result page the search has
 */
export async function readSearch(url) {
  return serialize(async () => {
    const adverts = [];
    const seen = new Set();

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await pause();
      const found = await readPage(pageUrl(url, page));
      if (found == null) break;

      const fresh = found.filter((advert) => advert.id != null && !seen.has(advert.id));
      for (const advert of fresh) seen.add(advert.id);
      adverts.push(...fresh);

      // A page past the last one comes back as the first one again, so a page carrying nothing new
      // is the end of the results whatever its length says.
      if (found.length < PAGE_SIZE || fresh.length === 0) break;
      if (page === MAX_PAGES) {
        logger.warn(`Idealista: stopped after ${MAX_PAGES} pages. Narrow the search to see the rest.`);
      }
    }

    return adverts;
  });
}
