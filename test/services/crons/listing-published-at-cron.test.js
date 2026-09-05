/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const root = (await import('node:path')).resolve('.');
const listingsStoragePath = root + '/lib/services/storage/listingsStorage.js';
const loggerPath = root + '/lib/services/logger.js';

/**
 * The four providers whose config the sweep borrows, stubbed per test. Each provider module is
 * mocked wholesale - the sweep only ever touches its `config.fetchDetails`, and the real ones
 * would reach for the network.
 */
const providerIds = ['tecnocasa', 'tecnorete', 'idealista', 'immobiliare'];

let state;

async function loadCron() {
  vi.resetModules();
  vi.doMock(listingsStoragePath, () => ({
    getListingsMissingPublishedAt: (providers) => {
      state.askedProviders = providers;
      return state.pending.filter((listing) => providers.includes(listing.provider));
    },
    updateListingPublishedAt: (id, publishedAt) => state.stored.push({ id, publishedAt }),
  }));
  for (const providerId of providerIds) {
    vi.doMock(`${root}/lib/provider/${providerId}.js`, () => ({
      config: {
        fetchDetails: async (listing) => {
          state.detailCalls.push({ provider: providerId, link: listing.link });
          if (state.failLinks?.includes(listing.link)) throw new Error('the host refused');
          return { publishedAt: state.dates[`${providerId}:${listing.link}`] };
        },
      },
    }));
  }
  vi.doMock(loggerPath, () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
  vi.doMock('node-cron', () => ({ default: { schedule: () => {} } }));
  return import(root + '/lib/services/crons/listing-published-at-cron.js');
}

/**
 * The sweep exists for the rows that were stored while a run's detail reads were being refused -
 * a search expanded into a hundred new listings can earn a block partway through the batch, and
 * the pipeline enriches only what it has not stored yet, so those rows would otherwise stay
 * dateless forever. What it may and may not do is shaped by two facts: a provider with no place
 * to ask must never enter the work list, and one advert the portal would not answer must not stop
 * the others.
 */
describe('services/crons/listing-published-at-cron', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Nothing in the sweep may reach the network in a test; the provider configs are mocked.
    globalThis.fetch = async () => {
      throw new Error('network is off limits in this test');
    };
    state = { pending: [], stored: [], detailCalls: [], dates: {}, askedProviders: null };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('reads each dateless row with its own provider and stores what the detail answers', async () => {
    state.pending = [
      { id: 'row-1', link: 'https://www.tecnocasa.it/vendita/1.html', provider: 'tecnocasa' },
      { id: 'row-2', link: 'https://www.idealista.it/it/ad/2/', provider: 'idealista' },
    ];
    state.dates = {
      'tecnocasa:https://www.tecnocasa.it/vendita/1.html': Date.UTC(2026, 5, 1, 10, 0, 0),
      'idealista:https://www.idealista.it/it/ad/2/': Date.UTC(2026, 5, 2, 9, 0, 0),
    };

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runPublishedAtBackfill();
    await vi.runAllTimersAsync();
    const didWork = await sweep;

    expect(didWork).toBe(true);
    expect(state.askedProviders.sort()).toEqual(['idealista', 'immobiliare', 'tecnocasa', 'tecnorete']);
    expect(state.stored).toEqual([
      { id: 'row-1', publishedAt: Date.UTC(2026, 5, 1, 10, 0, 0) },
      { id: 'row-2', publishedAt: Date.UTC(2026, 5, 2, 9, 0, 0) },
    ]);
  });

  it('names the whole enricher map, so a provider is never left with rows nobody reads', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.tecnocasa.it/vendita/1.html', provider: 'tecnocasa' }];

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runPublishedAtBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.askedProviders.sort()).toEqual(['idealista', 'immobiliare', 'tecnocasa', 'tecnorete']);
  });

  it('leaves a row the detail answers without a date on the list for the next sweep', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.idealista.it/it/ad/1/', provider: 'idealista' }];

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runPublishedAtBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.detailCalls).toHaveLength(1);
    expect(state.stored).toEqual([]);
  });

  it('carries on when one detail read is refused', async () => {
    state.pending = [
      { id: 'row-1', link: 'https://www.tecnocasa.it/vendita/1.html', provider: 'tecnocasa' },
      { id: 'row-2', link: 'https://www.tecnocasa.it/vendita/2.html', provider: 'tecnocasa' },
    ];
    state.failLinks = ['https://www.tecnocasa.it/vendita/1.html'];
    state.dates = { 'tecnocasa:https://www.tecnocasa.it/vendita/2.html': Date.UTC(2026, 5, 3, 8, 0, 0) };

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runPublishedAtBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.detailCalls).toHaveLength(2);
    expect(state.stored).toEqual([{ id: 'row-2', publishedAt: Date.UTC(2026, 5, 3, 8, 0, 0) }]);
  });

  it('does no work at all when nothing is missing', async () => {
    const cron = await loadCron();
    const didWork = await cron.runPublishedAtBackfill();

    expect(didWork).toBe(true);
    expect(state.detailCalls).toEqual([]);
  });

  it('skips a trigger that arrives while a sweep is still in flight', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.tecnocasa.it/vendita/1.html', provider: 'tecnocasa' }];
    state.dates = { 'tecnocasa:https://www.tecnocasa.it/vendita/1.html': Date.UTC(2026, 5, 4, 7, 0, 0) };

    const cron = await loadCron();
    vi.useFakeTimers();
    const first = cron.runPublishedAtBackfill();
    const second = await cron.runPublishedAtBackfill();

    await vi.runAllTimersAsync();
    await first;

    expect(second).toBe(false);
    expect(state.detailCalls).toHaveLength(1);
  });
});
