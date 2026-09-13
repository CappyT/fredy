/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import path from 'node:path';
import { configFilePath } from '../../utils.js';
import logger from '../logger.js';
import { DataDomeCookieStore } from './cookieStore.js';

const store = new DataDomeCookieStore(path.join(path.dirname(configFilePath()), 'datadome-cookies'));
const sessions = new WeakMap();

/**
 * Restore only DataDome cookies into a fresh browser before any navigation.
 * Cache failures are non-fatal and logs never contain cookie values or proxy URLs.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} [proxyUrl] Actual proxy used when this browser was launched.
 * @returns {Promise<void>}
 */
export async function restoreDataDomeCookies(browser, proxyUrl = '') {
  const session = { proxyUrl, restored: [] };
  sessions.set(browser, session);
  try {
    const context = browser.defaultBrowserContext();
    for (const cookie of store.load(proxyUrl)) {
      try {
        await context.setCookie(cookie);
        session.restored.push(cookie);
      } catch {
        logger.debug('Skipped a DataDome cookie rejected by the browser.');
      }
    }
    logger.debug(`Restored ${session.restored.length} cached DataDome cookies.`);
  } catch {
    logger.warn('Could not restore the DataDome cookie cache; continuing with a fresh session.');
  }
}

/**
 * Save the browser's latest DataDome cookies before its context is destroyed.
 * Browsers not launched by Fredy have no registered cache scope and are ignored.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<void>}
 */
export async function persistDataDomeCookies(browser) {
  const session = sessions.get(browser);
  if (!session) return;
  sessions.delete(browser);
  try {
    const cookies = await browser.defaultBrowserContext().cookies();
    store.save(session.proxyUrl, cookies, session.restored);
    logger.debug(`Saved ${cookies.filter((cookie) => cookie.name === 'datadome').length} DataDome cookies.`);
  } catch {
    logger.warn('Could not save the DataDome cookie cache; the next run may need a new session.');
  }
}
