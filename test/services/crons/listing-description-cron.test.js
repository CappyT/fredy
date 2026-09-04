/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const root = (await import('node:path')).resolve('.');
const listingsStoragePath = root + '/lib/services/storage/listingsStorage.js';
const propertyDetailPath = root + '/lib/services/immobiliare/propertyDetail.js';
const loggerPath = root + '/lib/services/logger.js';

let state;

async function loadCron() {
  vi.resetModules();
  vi.doMock(listingsStoragePath, () => ({
    getListingsMissingDescription: (providers) => {
      state.askedProviders = providers;
      return state.pending.filter((listing) => providers.includes(listing.provider));
    },
    updateListingDescription: (id, description) => state.stored.push({ id, description }),
  }));
  vi.doMock(propertyDetailPath, () => ({
    USER_AGENT: 'test-agent',
    advertIdInLink: (link) => link?.match(/\/annunci\/(\d+)\//)?.[1] ?? null,
    fetchPropertyDetail: async (advertId) => {
      state.detailCalls.push(advertId);
      if (state.failAdvertIds?.includes(String(advertId))) throw new Error('the api refused');
      return state.details[advertId] ?? null;
    },
    detailDescription: (detail) => {
      const content = detail?.description?.content;
      return typeof content === 'string' && content.trim().length > 0 ? content.trim() : null;
    },
  }));
  vi.doMock(loggerPath, () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
  vi.doMock('node-cron', () => ({ default: { schedule: () => {} } }));
  return import(root + '/lib/services/crons/listing-description-cron.js');
}

/**
 * The sweep exists for the rows that were stored before the provider read the description out of
 * the app api, and for the ones whose detail request failed on the night they were found. What it
 * may and may not do is shaped by two facts: a provider with no place to ask must never enter the
 * work list, and one advert the portal would not describe must not stop the others.
 */
describe('services/crons/listing-description-cron', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Nothing in the sweep may reach the network in a test; the propertyDetail service is mocked.
    globalThis.fetch = async () => {
      throw new Error('network is off limits in this test');
    };
    state = { pending: [], stored: [], detailCalls: [], details: {}, askedProviders: null };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('reads each row with its provider and stores what the detail answers', async () => {
    state.pending = [
      { id: 'row-1', link: 'https://www.immobiliare.it/annunci/132117784/', provider: 'immobiliare' },
      { id: 'row-2', link: 'https://www.immobiliare.it/annunci/131902574/', provider: 'immobiliare' },
    ];
    state.details = {
      132117784: { description: { reference: 'EK-132117784', content: '  Appartamento luminoso.  ' } },
      131902574: { description: { content: 'Bilocale ristrutturato.' } },
    };

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runDescriptionBackfill();
    await vi.runAllTimersAsync();
    const didWork = await sweep;

    expect(didWork).toBe(true);
    expect(state.askedProviders).toEqual(['immobiliare']);
    expect(state.detailCalls).toEqual(['132117784', '131902574']);
    expect(state.stored).toEqual([
      { id: 'row-1', description: 'Appartamento luminoso.' },
      { id: 'row-2', description: 'Bilocale ristrutturato.' },
    ]);
  });

  it('names only the providers it can enrich, so no row is swept that nobody would ever fill', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.immobiliare.it/annunci/1/', provider: 'immobiliare' }];

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runDescriptionBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.askedProviders).toEqual(['immobiliare']);
  });

  it('leaves a row the detail answers without a text on the list for the next sweep', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.immobiliare.it/annunci/1/', provider: 'immobiliare' }];
    state.details = { 1: { description: { reference: 'EK-1', content: '   ' } } };

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runDescriptionBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.detailCalls).toEqual(['1']);
    expect(state.stored).toEqual([]);
  });

  it('carries on when one detail request fails', async () => {
    state.pending = [
      { id: 'row-1', link: 'https://www.immobiliare.it/annunci/1/', provider: 'immobiliare' },
      { id: 'row-2', link: 'https://www.immobiliare.it/annunci/2/', provider: 'immobiliare' },
    ];
    state.failAdvertIds = ['1'];
    state.details = { 2: { description: { content: 'Secondo annuncio.' } } };

    const cron = await loadCron();
    vi.useFakeTimers();
    const sweep = cron.runDescriptionBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.detailCalls).toEqual(['1', '2']);
    expect(state.stored).toEqual([{ id: 'row-2', description: 'Secondo annuncio.' }]);
  });

  it('does no work at all when nothing is missing', async () => {
    const cron = await loadCron();
    const didWork = await cron.runDescriptionBackfill();

    expect(didWork).toBe(true);
    expect(state.detailCalls).toEqual([]);
  });

  it('skips a trigger that arrives while a sweep is still in flight', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.immobiliare.it/annunci/1/', provider: 'immobiliare' }];
    state.details = { 1: { description: { content: 'Testo.' } } };

    const cron = await loadCron();
    vi.useFakeTimers();
    const first = cron.runDescriptionBackfill();
    const second = await cron.runDescriptionBackfill();

    await vi.runAllTimersAsync();
    await first;

    expect(second).toBe(false);
    expect(state.detailCalls).toEqual(['1']);
  });
});
