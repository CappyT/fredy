/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Idealista.it, the Italian arm of the Spanish portal.
 *
 * DataDome guards the whole site, and it answers the first request of any client with a 403 and a
 * small interstitial. What clears that interstitial is a headful browser: a headless one runs the
 * same script and stays on the 1.5 kB block page however long it is given. A headful browser
 * clears it in under five seconds and leaves a `datadome` cookie behind.
 *
 * That cookie is the whole session. Carrying it, a plain `fetch` reads any search page, including
 * one the browser never opened, and it keeps working after the browser is gone. So the browser
 * runs only when there is no usable cookie, and every other run is a plain request.
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
import { launchBrowser, closeBrowser } from '../services/extractor/puppeteerExtractor.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://www.idealista.it';
const ACCEPT_LANGUAGE = 'it-IT,it;q=0.9,en;q=0.8';
const LISTING_SELECTOR = 'article.item';
const COOKIE_NAME = 'datadome';

/** Used until a browser has minted a session, whose own user agent then replaces it. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * The cookie and the user agent it was minted with, which DataDome checks against each other.
 *
 * Kept in the process rather than in the database: a restart costs one browser launch, and a
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
 * Open the search in a headful browser, wait for the wall to clear, and keep what it leaves.
 *
 * The page it renders is returned along with the cookie. The browser had to load the search
 * anyway, so reading the adverts off that render saves the request the caller would repeat.
 *
 * @param {string} url the search url
 * @returns {Promise<string|null>} the rendered page, or null when the wall did not clear
 */
async function mintSession(url) {
  logger.debug('Idealista: no usable session, solving the wall with a browser.');
  const browser = await launchBrowser(url, { puppeteerHeadless: false, acceptLanguage: ACCEPT_LANGUAGE });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(LISTING_SELECTOR, { timeout: 30_000 });

    const cookie = (await page.cookies()).find((entry) => entry.name === COOKIE_NAME)?.value;
    if (cookie == null) return null;

    session = { cookie, userAgent: await browser.userAgent() };
    return await page.content();
  } catch (error) {
    logger.error('Idealista: the browser did not get past DataDome.', error);
    return null;
  } finally {
    await closeBrowser(browser);
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

    logger.debug(`Idealista answered with a wall (${status}); solving it with a browser.`);
    session = null;

    const rendered = await mintSession(url);
    if (rendered == null) {
      logger.error('Idealista returned a wall the browser could not clear.');
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
