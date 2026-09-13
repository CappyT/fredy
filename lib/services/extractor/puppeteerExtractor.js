/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { launch } from 'cloakbrowser/puppeteer';
import { startVirtualDisplay } from './virtualDisplay.js';

import { botDetected, debug } from './utils.js';
import { getPreLaunchConfig } from './botPrevention.js';
import { solveCaptcha } from '../datadome/captcha.js';
import { restoreDataDomeCookies, persistDataDomeCookies } from '../datadome/browserCookies.js';
import logger from '../logger.js';
import { trackPoi } from '../tracking/Tracker.js';
import { TRACKING_POIS } from '../../TRACKING_POIS.js';

const browserDisplays = new WeakMap();

/**
 * Launch a CloakBrowser/Puppeteer browser instance with stealth and humanizer enabled.
 *
 * CloakBrowser applies 49 C++ source-level patches (canvas, WebGL, audio, WebRTC,
 * navigator.*, automation signals) that are indistinguishable from a real browser.
 * All fingerprinting and human-behaviour simulation is handled natively; no CDP
 * overrides (setUserAgent, setExtraHTTPHeaders, evaluateOnNewDocument) are applied
 * here because they would create detectable inconsistencies on top of the C++ patches.
 *
 * @param {string} url - Initial URL (used to derive locale/timezone hints).
 * @param {object} [options]
 * @param {boolean} [options.puppeteerHeadless] Defaults to false on Linux with datadome enabled,
 *   true otherwise. Explicit values take precedence.
 * @param {true|object} [options.datadome] Use a windowed display for the captcha path on Linux.
 *   Always starts a private Xvfb display, isolated from the desktop session.
 * @param {boolean} [options.humanize] CloakBrowser's native input humanizer; on by default. Input
 *   that already carries its own measured human timing is better served with it off - the two
 *   together read as a 20-second tremoring drag.
 * @param {number}  [options.puppeteerTimeout]
 * @param {string}  [options.proxyUrl]
 * @param {string}  [options.timezone]
 * @param {string}  [options.acceptLanguage]
 * @param {object}  [options.viewport]
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
export async function launchBrowser(url, options) {
  const preCfg = getPreLaunchConfig(url, options || {});

  // Docker requires --no-sandbox; CloakBrowser handles all stealth args internally.
  // --ignore-certificate-errors is needed because CloakBrowser ships its own Chromium
  // binary with an independent CA bundle that may not trust proxies or interceptors
  // present in the host environment.
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
    preCfg.windowSizeArg,
  ];

  const headless = options?.puppeteerHeadless ?? !(options?.datadome && process.platform === 'linux');
  const display =
    !headless && process.platform === 'linux' && (options?.datadome || !process.env.DISPLAY)
      ? await startVirtualDisplay()
      : null;
  // A private X server must not inherit the desktop's Wayland endpoint or X11
  // credentials. Force Chromium's X11 backend even inside a Wayland session.
  let displayEnv;
  if (display) {
    displayEnv = { ...process.env, DISPLAY: display.display, XDG_SESSION_TYPE: 'x11' };
    delete displayEnv.WAYLAND_DISPLAY;
    delete displayEnv.WAYLAND_SOCKET;
    delete displayEnv.XAUTHORITY;
    args.push('--ozone-platform=x11');
  }
  try {
    const browser = await launch({
      headless,
      ...(display ? { launchOptions: { env: displayEnv } } : {}),
      humanize: options?.humanize ?? true,
      args,
      // locale sets Accept-Language headers and JS navigator.language consistently
      locale: preCfg.langForFlag,
      ...(options?.proxyUrl ? { proxy: options.proxyUrl } : {}),
      ...(preCfg.timezone ? { timezone: preCfg.timezone } : {}),
    });
    if (display) {
      browserDisplays.set(browser, display);
      browser.once?.('disconnected', () => {
        void display.close();
      });
    }
    await restoreDataDomeCookies(browser, options?.proxyUrl);
    return browser;
  } catch (error) {
    await display?.close();
    throw error;
  }
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
 * @param {import('puppeteer-core').Browser | null} browser
 * @returns {Promise<void>}
 */
export async function closeBrowser(browser) {
  if (!browser) return;
  await persistDataDomeCookies(browser);
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
  await browserDisplays.get(browser)?.close();
  browserDisplays.delete(browser);
}

/**
 * Open a page in a (possibly reused) browser, navigate to `url`, and return the HTML source.
 * Returns `null` when a bot-detection page is encountered or on timeout.
 *
 * @param {string} url
 * @param {string | null} waitForSelector
 * @param {object} [options]
 * @param {boolean} [options.puppeteerHeadless]
 * @param {boolean} [options.humanize] Defaults to false for an owned browser with DataDome enabled,
 *   since the solver already supplies timed mouse movements. Explicit values take precedence.
 * @param {import('puppeteer-core').Browser} [options.browser] Shared browser; launch options such as
 *   acceptLanguage, humanize and puppeteerHeadless cannot change an already running browser.
 * @param {number}  [options.puppeteerTimeout]
 * @param {string}  [options.proxyUrl]
 * @param {string}  [options.timezone]
 * @param {string}  [options.acceptLanguage]
 * @param {object}  [options.viewport]
 * @param {true|object} [options.datadome] clear a DataDome wall standing in front of the page
 *   before its source is read: `true` for the solver's defaults, or an object of its options
 *   (see `lib/services/datadome/captcha.js`). The answer the navigation gave decides how long the
 *   look takes - a page that came back as content costs a fraction of a second
 * @param {(page: import('puppeteer-core').Page) => Promise<boolean|void>} [options.onPage] called
 *   with the page once it has loaded and before the source is read; returning true says the hook
 *   re-navigated the page to content that replaced a blocked response
 * @returns {Promise<string | null>}
 */
export default async function execute(url, waitForSelector, options) {
  let browser = options?.browser;
  let isExternalBrowser = !!browser;
  let page;
  let result;
  try {
    debug(`Sending request to ${url} using CloakBrowser.`);

    if (!isExternalBrowser) {
      browser = await launchBrowser(url, { ...options, humanize: options?.humanize ?? !options?.datadome });
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

    // A DataDome wall, if the provider said there could be one. Runs before the
    // idle wait: the reload that clears the wall is traffic that wait would
    // otherwise sit through, and the document is only worth reading once the
    // wall in front of it has gone.
    let recoveredInPage = false;
    if (options?.datadome) {
      const solverOptions = options.datadome === true ? {} : options.datadome;
      try {
        recoveredInPage = (await solveCaptcha(page, { ...solverOptions, response })) === true;
      } catch (error) {
        logger.warn('Error clearing the DataDome wall', error);
      }
    }

    // Optional second idle wait: useful for React SPAs that trigger API calls
    // after domcontentloaded. Times out silently so we use whatever is rendered.
    if (options?.waitForNetworkIdle) {
      try {
        await page.waitForNetworkIdle({ timeout: options?.waitForNetworkIdleTimeout ?? 60_000 });
      } catch {
        // ignore - we proceed with whatever the DOM contains at this point
      }
    }

    // A hook for what the document became: an anti-bot wall a human could
    // clear can be cleared in the page itself. True means the page answered
    // the hook by re-navigating to its real content, which also means the
    // navigation response below no longer describes what is on screen.
    if (typeof options?.onPage === 'function') {
      try {
        recoveredInPage = (await options.onPage(page)) === true || recoveredInPage;
      } catch (error) {
        logger.warn('Error running the onPage hook', error);
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

    const statusCode = recoveredInPage ? 200 : (response?.status?.() ?? 200);

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
      logger.debug('Error executing with CloakBrowser executor', error);
    } else {
      logger.warn('Error executing with CloakBrowser executor', error);
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
