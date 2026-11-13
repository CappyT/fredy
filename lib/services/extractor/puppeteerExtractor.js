/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import path from 'node:path';
import { randomUUID } from 'crypto';
import puppeteer from 'puppeteer-core';
import { serve } from 'clearcote';
import { launch as launchCloakBrowser } from 'cloakbrowser/puppeteer';
import { botDetected, debug } from './utils.js';
import { getPreLaunchConfig } from './botPrevention.js';
import { randomSessionId, readIproyalOptions, writeIproyalOptions } from '../proxy/iproyal.js';
import { browserEngineName, usesClearcote } from './browserEngine.js';
import logger from '../logger.js';
import { trackPoi } from '../tracking/Tracker.js';
import { TRACKING_POIS } from '../../TRACKING_POIS.js';

/**
 * The proxy each browser was launched through: its url, and the credentials its pages have to send.
 *
 * CloakBrowser guarantees proxy auth only on pages made by `browser.newPage`. On a binary without
 * inline proxy auth it strips the credentials off `--proxy-server` and patches that one method to
 * call `page.authenticate`, so a page opened in a context of its own reaches the proxy with no
 * credentials and the navigation fails at once with `ERR_INVALID_AUTH_CREDENTIALS`. Measured: the
 * same deployment launches with the credentials inline for one url and stripped for another.
 *
 * The url is kept beside the credentials because the exit node is steered through it, see
 * {@link rotatedExit}.
 *
 * @type {WeakMap<import('puppeteer-core').Browser, {url: string, auth: {username: string, password: string}}>}
 */
const proxyByBrowser = new WeakMap();

/**
 * Disk cache slots in use, one per running browser.
 *
 * The residential proxy is billed per byte, and a portal's scripts and stylesheets are the same on
 * every run. A persistent `--disk-cache-dir` keeps them across runs while the profile, and with it
 * the cookies, stays throwaway. Two Chromium processes must not share one cache directory, so each
 * running browser takes a slot of its own.
 *
 * @type {Set<number>}
 */
const cacheSlotsInUse = new Set();

/** @type {WeakMap<import('puppeteer-core').Browser, number>} */
const cacheSlotByBrowser = new WeakMap();

const CACHE_SIZE_BYTES = 200 * 1024 * 1024;

function takeCacheSlot() {
  let slot = 0;
  while (cacheSlotsInUse.has(slot)) slot++;
  cacheSlotsInUse.add(slot);
  return slot;
}

/** @param {import('puppeteer-core').Browser} browser */
function releaseCacheSlot(browser) {
  const slot = cacheSlotByBrowser.get(browser);
  if (slot == null) return;
  cacheSlotByBrowser.delete(browser);
  cacheSlotsInUse.delete(slot);
}

/**
 * Remember what a browser has to say to its proxy, for the pages CloakBrowser does not cover.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string|undefined} proxyUrl The proxy url the browser was launched with.
 * @returns {void}
 */
function rememberProxy(browser, proxyUrl) {
  if (!proxyUrl) return;
  try {
    const { username, password } = new URL(proxyUrl);
    if (!username) return;
    proxyByBrowser.set(browser, {
      url: proxyUrl,
      auth: { username: decodeURIComponent(username), password: decodeURIComponent(password) },
    });
  } catch {
    // An unusable proxy url is the launch's problem to report, not this one's.
  }
}

/**
 * The credentials that ask the proxy for an exit node it has not used yet.
 *
 * IPRoyal carries a sticky session in the password (`..._session-<id>_lifetime-5m`), and a session
 * id it has not seen starts a new session on a new exit node, so there is no lifetime to wait out.
 * A password with no session segment rotates on every request, so a fresh context already leaves
 * from a new address and the password stays as it is. Any other proxy, or none at all, cannot be
 * steered, which is why the answer says whether the address really changes.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @returns {{auth: {username: string, password: string}|null, rotated: boolean}} the credentials to
 *   use instead of the remembered ones, and whether the exit node really changes
 */
function rotatedExit(browser) {
  const proxy = proxyByBrowser.get(browser);
  const options = proxy == null ? null : readIproyalOptions(proxy.url);
  if (options == null) return { auth: null, rotated: false };
  if (!options.sticky) return { auth: null, rotated: true };

  const { username, password } = new URL(writeIproyalOptions(proxy.url, { ...options, sessionId: randomSessionId() }));
  return {
    auth: { username: decodeURIComponent(username), password: decodeURIComponent(password) },
    rotated: true,
  };
}

/**
 * Open a page in a browser context of its own, able to talk to the proxy.
 *
 * A context of its own is what keeps one read from carrying another's cookies - a portal that
 * refuses one page can otherwise refuse every later one on the same context - and the
 * authentication is what {@link proxyByBrowser} exists for.
 *
 * The caller closes both, the page first.
 *
 * @param {import('puppeteer-core').Browser} browser The shared browser of the current job run.
 * @param {object} [options]
 * @param {boolean} [options.freshExit] Ask the proxy for an exit node it has not used yet, for a
 *   read that was refused because of the address it came from.
 * @param {{username: string, password: string}|null} [options.auth] Credentials an earlier call
 *   answered with, so this context leaves from the same address as that one did.
 * @returns {Promise<{page: import('puppeteer-core').Page, context: any,
 *   auth: {username: string, password: string}|null, exitRotated: boolean}>} the page and its
 *   context, the credentials they were authenticated with, and whether `freshExit` changed the exit.
 */
export async function newIsolatedPage(browser, { freshExit = false, auth = null } = {}) {
  const rotation = freshExit && auth == null ? rotatedExit(browser) : null;
  const credentials = auth ?? rotation?.auth ?? proxyByBrowser.get(browser)?.auth ?? null;

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (credentials != null) await page.authenticate(credentials);
  return { page, context, auth: credentials, exitRotated: rotation?.rotated ?? false };
}

/**
 * The Clearcote server behind each browser {@link launchBrowser} connected to, so
 * {@link closeBrowser} can stop it. Keyed by the browser, so concurrent runs never share an entry.
 *
 * @type {WeakMap<import('puppeteer-core').Browser, import('clearcote').Server>}
 */
const clearcoteServers = new WeakMap();

/**
 * Launch the stealth Chromium this machine drives (see `browserEngine.js`) and return a Puppeteer
 * browser for it.
 *
 * Both engines patch the fingerprint (canvas, WebGL, audio, WebRTC, navigator.*, automation signals)
 * in the browser's C++ source, so nothing is overridden over CDP here (setUserAgent,
 * setExtraHTTPHeaders, evaluateOnNewDocument): that would add detectable inconsistencies on top.
 *
 * @param {string} url - Initial URL (used to derive locale/timezone hints).
 * @param {object} [options]
 * @param {boolean} [options.puppeteerHeadless]
 * @param {number}  [options.puppeteerTimeout]
 * @param {string}  [options.proxyUrl]
 * @param {string}  [options.timezone]
 * @param {string}  [options.acceptLanguage]
 * @param {object}  [options.viewport]
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
export async function launchBrowser(url, options) {
  const preCfg = getPreLaunchConfig(url, options || {});
  const cacheSlot = takeCacheSlot();
  const headless = options?.puppeteerHeadless ?? true;

  // Docker requires --no-sandbox. --ignore-certificate-errors is needed because CloakBrowser ships
  // its own Chromium binary with an independent CA bundle that may not trust proxies or
  // interceptors present in the host environment; Clearcote gets the same flags so both engines
  // behave alike behind a proxy.
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    // Disables the zygote process model. Required in some container environments
    // (e.g. limited kernel namespaces) where the zygote cannot acquire the
    // locks it needs and exits with "Invalid file descriptor to ICU data received".
    '--no-zygote',
    // No listing is read from its pictures, and every byte through the proxy is billed.
    '--blink-settings=imagesEnabled=false',
    `--disk-cache-dir=${path.join(process.cwd(), 'db', 'browser-cache', String(cacheSlot))}`,
    `--disk-cache-size=${CACHE_SIZE_BYTES}`,
  ];

  let browser;
  try {
    browser = usesClearcote()
      ? await launchClearcote(preCfg, args, headless, options?.proxyUrl)
      : await launchCloakBrowserEngine(preCfg, args, headless, options?.proxyUrl);
  } catch (error) {
    cacheSlotsInUse.delete(cacheSlot);
    throw error;
  }
  cacheSlotByBrowser.set(browser, cacheSlot);
  rememberProxy(browser, options?.proxyUrl);
  return browser;
}

/**
 * Start Clearcote's open build as a CDP endpoint and connect Puppeteer to it.
 *
 * `serve()` starts the binary itself rather than through Puppeteer, so `--enable-automation` never
 * reaches the command line, and it adds the persona switches the SDK keeps coherent with each
 * other. Without a licence key the SDK contacts none of Clearcote's services.
 *
 * @param {ReturnType<typeof getPreLaunchConfig>} preCfg
 * @param {string[]} args
 * @param {boolean} headless
 * @param {string} [proxyUrl]
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchClearcote(preCfg, args, headless, proxyUrl) {
  const server = await serve({
    // A new machine per launch, as CloakBrowser does it. Without a seed every Fredy installation
    // would present the very same one.
    fingerprint: randomUUID(),
    // The same honest Linux persona as for CloakBrowser below, for the same reason.
    ...(process.platform === 'linux' ? { platform: 'linux' } : {}),
    acceptLanguage: preCfg.acceptLanguage,
    timezone: preCfg.timezone,
    // Fredy sets language and timezone itself. Left on, the SDK looks up the public IP with a
    // third-party service on every launch to derive them.
    geoip: false,
    headless,
    windowSize: { width: preCfg.viewport.width, height: preCfg.viewport.height },
    args,
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
    // Otherwise every launch prints the endpoint and the SDK's usage notes. ensureValidBinary()
    // already fetched the binary at startup, which is where its download progress belongs.
    quiet: true,
  });

  try {
    // viewport null: pages take the window's size, which serve() fitted to the persona's screen.
    const browser = await puppeteer.connect({ browserURL: server.cdpUrl, defaultViewport: null });
    clearcoteServers.set(browser, server);
    return browser;
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}

/**
 * Launch CloakBrowser's keyless build, for the platforms Clearcote does not build for.
 *
 * @param {ReturnType<typeof getPreLaunchConfig>} preCfg
 * @param {string[]} args
 * @param {boolean} headless
 * @param {string} [proxyUrl]
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchCloakBrowserEngine(preCfg, args, headless, proxyUrl) {
  return await launchCloakBrowser({
    headless,
    humanize: true,
    args: [
      ...args,
      preCfg.windowSizeArg,
      // On a Linux host CloakBrowser poses as Windows by default, but a Linux box (Docker above all)
      // has none of the fonts every Windows install carries (Segoe UI, Calibri, Consolas), and we
      // cannot ship them. DataDome sees through that mismatch: immowelt challenged the warm-up and
      // answered every search with 403, while the same container posing as Linux got through.
      // An honest Linux persona keeps UA, client hints and fonts telling the same story.
      ...(process.platform === 'linux' ? ['--fingerprint-platform=linux'] : []),
    ],
    // locale sets Accept-Language headers and JS navigator.language consistently
    locale: preCfg.langForFlag,
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
    ...(preCfg.timezone ? { timezone: preCfg.timezone } : {}),
  });
}

/**
 * SIGKILL a Chromium process tree that is still alive.
 *
 * Puppeteer spawns Chromium with `detached: true` on every non-Windows platform, which makes the
 * browser process the leader of its own process group. Signalling the negative pid therefore takes
 * down the whole tree (browser, gpu, crashpad handler and - because of `--no-zygote` - every
 * renderer), instead of only the parent that would leave its children orphaned.
 *
 * @param {import('child_process').ChildProcess | null | undefined} childProcess
 * @returns {void}
 */
function killProcessTree(childProcess) {
  const pid = childProcess?.pid;
  // exitCode/signalCode are set as soon as node has reaped the process - nothing left to kill.
  if (pid == null || childProcess.exitCode != null || childProcess.signalCode != null) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // No such process group (already gone, or Windows, which has no process groups) - fall back
    // to the plain process kill.
    try {
      childProcess.kill('SIGKILL');
    } catch {
      // ignore - the process is gone
    }
  }
}

/**
 * Close a browser instance returned by {@link launchBrowser}.
 *
 * `browser.close()` on its own is not enough: when the CDP connection is already gone (renderer
 * crash, OOM kill, a provider page that took the tab down) it rejects and leaves the Chromium
 * process tree behind. Those leftovers get reparented to pid 1 and, in the Docker image, pile up
 * as `<defunct>` entries. The hard kill runs on both paths so no run can leak a browser.
 *
 * A Clearcote browser is only connected to, so Puppeteer holds no process for it. Its server owns
 * the process and stops it instead.
 *
 * @param {import('puppeteer-core').Browser | null} browser
 * @returns {Promise<void>}
 */
export async function closeBrowser(browser) {
  if (!browser) return;
  const server = clearcoteServers.get(browser);
  if (server != null) {
    clearcoteServers.delete(browser);
    try {
      await browser.close();
    } catch {
      // ignore - the server below stops the process either way
    }
    try {
      // Waits for the browser to exit (SIGTERM, then SIGKILL after 10 s) and removes the
      // temporary profile serve() created.
      await server.close();
    } catch {
      // ignore - nothing left to stop
    }
    releaseCacheSlot(browser);
    return;
  }
  // Reading the handle must not be what stops the cleanup: CloakBrowser hands back a guarded
  // object, and a browser that is already broken is exactly the one whose process tree has to be
  // killed. Without the guard a throw here skips both `close()` and the hard kill below.
  let childProcess = null;
  try {
    childProcess = typeof browser.process === 'function' ? browser.process() : null;
  } catch {
    // ignore - killProcessTree simply has no pid to work with
  }
  try {
    await browser.close();
  } catch {
    // ignore - killProcessTree below is the fallback
  }
  killProcessTree(childProcess);
  // Freed only after the kill: the cache directory is Chromium's until its process is gone.
  releaseCacheSlot(browser);
}

/**
 * Open a page in a (possibly reused) browser, navigate to `url`, and return the HTML source.
 * Returns `null` when a bot-detection page is encountered or on timeout.
 *
 * @param {string} url
 * @param {string | null} waitForSelector
 * @param {object} [options]
 * @returns {Promise<string | null>}
 */
export default async function execute(url, waitForSelector, options) {
  let browser = options?.browser;
  let isExternalBrowser = !!browser;
  let page;
  let result;
  try {
    debug(`Sending request to ${url} using ${browserEngineName()}.`);

    if (!isExternalBrowser) {
      browser = await launchBrowser(url, options);
    }

    page = await browser.newPage();

    if (Array.isArray(options?.cookies) && options.cookies.length > 0) {
      await page.setCookie(...options.cookies);
    }

    // Warm-up navigation: visit a trusted page first so the site sees an
    // established session before the actual target URL. Silently ignored on
    // failure so it never blocks the main request.
    if (options?.preNavigateUrl) {
      try {
        await page.goto(options.preNavigateUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
      } catch {
        // ignore
      }
    }

    const response = await page.goto(url, {
      waitUntil: options?.waitUntil || 'domcontentloaded',
      timeout: options?.puppeteerTimeout || 60000,
    });

    // Optional second idle wait: useful for React SPAs that trigger API calls
    // after domcontentloaded. Times out silently so we use whatever is rendered.
    if (options?.waitForNetworkIdle) {
      try {
        await page.waitForNetworkIdle({ timeout: options?.waitForNetworkIdleTimeout ?? 60_000 });
      } catch {
        // ignore - we proceed with whatever the DOM contains at this point
      }
    }

    let pageSource;
    if (waitForSelector != null) {
      const selectorTimeout = options?.puppeteerSelectorTimeout ?? options?.puppeteerTimeout ?? 30_000;
      await page.waitForSelector(waitForSelector, { timeout: selectorTimeout });
      pageSource = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerHTML : '';
      }, waitForSelector);
    } else {
      pageSource = await page.content();
    }

    const statusCode = response?.status?.() ?? 200;

    if (botDetected(pageSource, statusCode)) {
      logger.warn('We have been detected as a bot :-/ Tried url: => ', url);

      if (options != null && options.name != null) {
        await trackPoi(TRACKING_POIS.DETECTED_AS_BOT + '_' + options.name);
      } else {
        await trackPoi(TRACKING_POIS.DETECTED_AS_BOT);
      }

      result = null;
    } else {
      result = pageSource || (await page.content());
    }
  } catch (error) {
    if (error?.name?.includes('Timeout')) {
      logger.debug(`Error executing with ${browserEngineName()}`, error);
    } else {
      logger.warn(`Error executing with ${browserEngineName()}`, error);
    }
    result = null;
  } finally {
    try {
      if (page) {
        await page.close();
      }
    } catch {
      // ignore
    }
    if (browser != null && !isExternalBrowser) {
      await closeBrowser(browser);
    }
  }
  return result;
}
