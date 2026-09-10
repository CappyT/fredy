/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';

/**
 * The photograph keeping at scrape time.
 *
 * Every stored listing gets its photograph downloaded once, keyed on the row id the store just
 * propagated onto it, and a failed download costs the listing nothing but its photograph for now -
 * never the run. The url the portal handed out stays on the row either way: it is what the image
 * route redirects to when the bytes are not there.
 */
describe('pipeline - keeping the photograph', () => {
  /** @returns {Object} a pipeline configuration with one listing that carries an image url */
  const configWith = (listing) => ({
    url: 'http://example.com',
    getListings: () => Promise.resolve([listing]),
    normalize: (l) => l,
    filter: () => true,
    requiredFieldNames: ['id', 'title', 'link'],
  });

  const runOnePass = async (providerConfig, job = {}) => {
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      providerConfig,
      { id: 'job-1', notificationAdapter: [{ id: 'mock-adapter' }], ...job },
      'test-provider',
      { checkAndAddEntry: () => false },
      undefined,
    );
    try {
      await fredy.execute();
    } catch {
      // NoNewListingsWarning is control flow, not an error.
    }
  };

  beforeEach(() => {
    mockStore.resetListings();
    mockStore.setUserSettings({ provider_details: [] });
    mockStore.setGeocodeResult(null);
  });

  it('keeps the bytes of the photograph the scrape found', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/webp' : null) },
      arrayBuffer: async () => Buffer.from('photograph-bytes'),
    });
    try {
      await runOnePass(
        configWith({ id: 'hash-1', title: 'Flat', link: 'https://portal/1/', price: 100000, image: 'https://img/1' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mockStore.storedImages).toEqual([{ listingId: 'hash-1', mimeType: 'image/webp', size: 16 }]);
  });

  it('finishes the run when the portal refuses the photograph', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('the cdn refused');
    };
    try {
      await runOnePass(
        configWith({ id: 'hash-1', title: 'Flat', link: 'https://portal/1/', price: 100000, image: 'https://img/1' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mockStore.storedImages).toEqual([]);
    // The run went on and stored the listing anyway.
    expect(mockStore.getKnownListingHashesForJob('job-1')).toContain('hash-1');
  });

  it('downloads nothing for a listing the area filter is about to soft-delete', async () => {
    /** A small square around Berlin; the listing below sits in Munich. */
    const spatialFilter = {
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [13.3, 52.4],
                [13.5, 52.4],
                [13.5, 52.6],
                [13.3, 52.6],
                [13.3, 52.4],
              ],
            ],
          },
        },
      ],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('the photograph of a rejected listing must never be fetched');
    };
    try {
      await runOnePass(
        configWith({
          id: 'hash-1',
          title: 'Flat',
          link: 'https://portal/1/',
          price: 100000,
          image: 'https://img/1',
          latitude: 48.13,
          longitude: 11.58,
        }),
        { spatialFilter },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The row is a tombstone by the time the image step runs, and a blob per tombstone is a
    // download at the portal and a table row spent on something nobody will open.
    expect(mockStore.storedImages).toEqual([]);
    expect(mockStore.deletedIds).toContain('hash-1');
  });

  it('downloads nothing for a listing the portal showed no image for', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network is off limits in this test');
    };
    try {
      await runOnePass(configWith({ id: 'hash-1', title: 'Flat', link: 'https://portal/1/', price: 100000 }));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mockStore.storedImages).toEqual([]);
    expect(mockStore.getKnownListingHashesForJob('job-1')).toContain('hash-1');
  });
});
