/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const root = (await import('node:path')).resolve('.');
const listingsStoragePath = root + '/lib/services/storage/listingsStorage.js';
const searchPath = root + '/lib/services/idealista/search.js';
const loggerPath = root + '/lib/services/logger.js';

let state;

async function loadService() {
  vi.resetModules();
  vi.doMock(listingsStoragePath, () => ({
    getListingsMissingStoredImage: (providers, limit) => {
      state.askedProviders = providers;
      return state.pending.filter((row) => providers.includes(row.provider)).slice(0, limit ?? state.pending.length);
    },
    updateListingImage: (id, imageUrl) => state.urlUpdates.push({ id, imageUrl }),
    storeListingImage: (id, mimeType, bytes) => state.kept.push({ id, mimeType, size: bytes.length }),
  }));
  vi.doMock(searchPath, () => ({
    readAdvert: async (code) => {
      state.advertCalls.push(code);
      return state.adverts[code] ?? null;
    },
  }));
  vi.doMock(loggerPath, () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
  return import(root + '/lib/services/listings/imageBackfillService.js');
}

/**
 * The sweep downloads what the portals still serve and asks the advert api for a fresh signature
 * where the stored url has lapsed. What must hold: an expired url is not a failure forever, a
 * portal without the photograph any more is, and one refusal never stops the others.
 */
describe('services/listings/imageBackfillService', () => {
  /** @type {typeof fetch} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    state = { pending: [], kept: [], urlUpdates: [], advertCalls: [], adverts: {}, images: {} };
    globalThis.fetch = async (url) => {
      const image = state.images[url];
      if (image == null) throw new Error('connection dropped');
      return { ok: true, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? image.mime : null) }, arrayBuffer: async () => image.bytes };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('downloads the photograph each row carries and keeps its bytes', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.idealista.it/it/ad/1/', image_url: 'https://img/1', provider: 'idealista' }];
    state.images = { 'https://img/1': { mime: 'image/webp', bytes: Buffer.from('photograph') } };

    const service = await loadService();
    vi.useFakeTimers();
    const sweep = service.runImageBackfill();
    await vi.runAllTimersAsync();
    const didWork = await sweep;

    expect(didWork).toBe(true);
    expect(state.kept).toEqual([{ id: 'row-1', mimeType: 'image/webp', size: 10 }]);
    expect(state.urlUpdates).toEqual([]);
  });

  it('asks the advert api for a fresh signature when the stored url has lapsed', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.idealista.it/immobile/36711892/', image_url: 'https://img/expired', provider: 'idealista' }];
    state.adverts = { 36711892: { thumbnail: 'https://img/fresh' } };
    state.images = { 'https://img/fresh': { mime: 'image/webp', bytes: Buffer.from('freshbytes') } };

    const service = await loadService();
    vi.useFakeTimers();
    const sweep = service.runImageBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.advertCalls).toEqual(['36711892']);
    expect(state.kept).toEqual([{ id: 'row-1', mimeType: 'image/webp', size: 10 }]);
    expect(state.urlUpdates).toEqual([{ id: 'row-1', imageUrl: 'https://img/fresh' }]);
  });

  it('leaves a listing the portal no longer serves on the work list', async () => {
    state.pending = [{ id: 'row-1', link: 'https://www.idealista.it/it/ad/1/', image_url: 'https://img/expired', provider: 'idealista' }];

    const service = await loadService();
    vi.useFakeTimers();
    const sweep = service.runImageBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.advertCalls).toEqual(['1']);
    expect(state.kept).toEqual([]);
    expect(state.urlUpdates).toEqual([]);
  });

  it('carries on when one download fails', async () => {
    state.pending = [
      { id: 'row-1', link: 'https://www.idealista.it/it/ad/1/', image_url: 'https://img/broken', provider: 'idealista' },
      { id: 'row-2', link: 'https://www.idealista.it/it/ad/2/', image_url: 'https://img/2', provider: 'idealista' },
    ];
    state.images = { 'https://img/2': { mime: 'image/jpeg', bytes: Buffer.from('second') } };

    const service = await loadService();
    vi.useFakeTimers();
    const sweep = service.runImageBackfill();
    await vi.runAllTimersAsync();
    await sweep;

    expect(state.kept).toEqual([{ id: 'row-2', mimeType: 'image/jpeg', size: 6 }]);
  });

  it('does no work at all when nothing is missing', async () => {
    const service = await loadService();
    const didWork = await service.runImageBackfill();

    expect(didWork).toBe(true);
    expect(state.kept).toEqual([]);
  });
});
