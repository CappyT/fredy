/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi } from 'vitest';
import { readFile } from 'fs/promises';
import * as mockStore from './mocks/mockStore.js';
import { send, sendPriceChange } from './mocks/mockNotification.js';

export const providerConfig = JSON.parse(
  await readFile(new URL('./provider/testProvider.json', import.meta.url), 'utf-8'),
);

export const sseEvents = [];

vi.mock('../lib/services/storage/listingsStorage.js', () => mockStore);
vi.mock('../lib/services/storage/settingsStorage.js', () => mockStore);
vi.mock('../lib/services/geocoding/geoCodingService.js', () => ({
  geocodeAddress: mockStore.geocodeAddress,
}));
vi.mock('../lib/services/storage/jobStorage.js', () => ({
  getJob: (jobKey) => ({ id: jobKey, userId: 'user1', notificationAdapter: [{ id: 'mock-adapter' }] }),
}));
vi.mock('../lib/services/sse/sse-broker.js', () => ({
  sendToUser: (userId, event, data) => {
    sseEvents.push({ userId, event, data });
  },
}));
vi.mock('../lib/notification/notify.js', () => ({ send, sendPriceChange }));
// The link lane wraps its price change and hash rename in a transaction; the mock store has no database.
vi.mock('../lib/services/storage/SqliteConnection.js', () => ({
  default: { withTransaction: (callback) => callback() },
}));

vi.mock('../lib/services/extractor/puppeteerExtractor.js', async (importOriginal) => {
  if (process.env.TEST_MODE !== 'offline') {
    return importOriginal();
  }
  const { readFixture } = await import('./offlineFixtures.js');
  return {
    // the options carry the provider's run name, which is the only way to map detail pages
    // that live on a partner domain back to their fixture
    default: (url, waitForSelector, options) => readFixture(url, options),
    // The offline browser answers a navigation out of the same fixture table the fetch mock reads,
    // so a provider that asks its api inside the browser is served what one asking over fetch got.
    launchBrowser: async () => ({
      close: async () => {},
      isConnected: () => true,
      createBrowserContext: async () => ({
        newPage: async () => ({
          goto: async (url) => {
            const answer = await globalThis.fetch(url);
            const body = typeof answer.json === 'function' ? JSON.stringify(await answer.json()) : await answer.text();
            return { status: () => answer.status ?? 200, text: async () => body };
          },
          setCookie: async () => {},
          close: async () => {},
        }),
        close: async () => {},
      }),
    }),
    closeBrowser: async () => {},
    // A provider that reads an api inside the browser opens each read in a context of its own.
    // Mirrored rather than imported: the real one pulls in the CloakBrowser binary, and the stub
    // browsers the tests hand it carry no proxy credentials to apply.
    newIsolatedPage: async (browser) => {
      const context = await browser.createBrowserContext();
      return { page: await context.newPage(), context };
    },
  };
});

// Immowelt talks to its search BFF from inside the browser page (the only place a DataDome cookie
// is worth anything), so neither the extractor mock nor the fetch mock above can intercept it. The
// transport module is swapped out wholesale instead.
vi.mock('../lib/services/immowelt/immoweltBff.js', async (importOriginal) => {
  if (process.env.TEST_MODE !== 'offline') {
    return importOriginal();
  }
  const { readImmoweltFixtures } = await import('./offlineFixtures.js');
  return {
    IMMOWELT_ORIGIN: 'https://www.immowelt.de',
    searchClassifieds: async () => (await readImmoweltFixtures()).classifieds,
    fetchExposeHtml: async () => (await readImmoweltFixtures()).detailHtml,
    releaseSession: async () => {},
    resolveSearchAreas: async (_browser, request) => request,
  };
});

// Offline runs replace browser navigation with the recorded result page.
vi.mock('../lib/services/idealista/idealistaSearch.js', async (importOriginal) => {
  if (process.env.TEST_MODE !== 'offline') {
    return importOriginal();
  }
  const { readFixture } = await import('./offlineFixtures.js');
  return { fetchSearchHtml: async (url) => readFixture(url) };
});

if (process.env.TEST_MODE === 'offline') {
  const { buildFetchMock } = await import('./offlineFixtures.js');
  vi.stubGlobal('fetch', buildFetchMock());
}

/**
 * The pipeline, with the detail-page enrichment capped at one listing.
 *
 * The cap used to live in the pipeline itself as `process.env.NODE_ENV === 'test'`. It belongs
 * here: a fixture run only needs to prove the enrichment path works once, and walking every
 * listing's detail page makes the provider suites slow (and, in live mode, rude).
 *
 * @returns {Promise<typeof import('../lib/FredyPipelineExecutioner.js').default>} A subclass that
 *   applies the cap, so the tests can keep constructing it with the production signature.
 */
export const mockFredy = async () => {
  const mod = await import('../lib/FredyPipelineExecutioner.js');
  const FredyPipelineExecutioner = mod.default;
  return class TestPipeline extends FredyPipelineExecutioner {
    constructor(providerConfig, job, providerId, similarityCache, browser, options = {}) {
      super(providerConfig, job, providerId, similarityCache, browser, { maxDetailFetches: 1, ...options });
    }
  };
};
