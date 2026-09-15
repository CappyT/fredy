/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi } from 'vitest';

const root = (await import('node:path')).resolve('.');

const PORTAL = {
  metaInformation: { id: 'portal' },
  config: { priceRangeParams: { min: 'priceMin', max: 'priceMax' } },
};
const JOB = {
  id: 'job-1',
  dealType: 'rent',
  specFilter: null,
  provider: [{ id: 'portal', url: 'https://portal.example/s' }],
};

/**
 * The price observation reports a job's medians to a side that reads every figure as euros. A job
 * whose medians are quoted in francs has nothing it could send without passing one off as the other.
 *
 * @param {string|undefined} currency What the storage says the medians are quoted in.
 * @returns {Promise<Array>} The requests that went to `/price`.
 */
async function observe(currency) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ stored: true }) }));

  vi.resetModules();
  vi.doMock('node-fetch', () => ({ default: fetchMock }));
  vi.doMock(root + '/lib/services/storage/listingsStorage.js', () => ({
    getListingsKpisForJobIds: () => ({
      numberOfActiveListings: 20,
      medianPriceOfListings: 2400,
      medianPricePerSqm: { dealType: 'rent', value: 38.5, sampleSize: 20 },
      ...(currency === undefined ? {} : { currency }),
    }),
  }));
  vi.doMock(root + '/lib/services/storage/jobStorage.js', () => ({ getJobs: () => [JOB] }));
  vi.doMock(root + '/lib/services/storage/settingsStorage.js', () => ({
    getSettings: async () => ({ analyticsEnabled: true, demoMode: false }),
  }));
  vi.doMock(root + '/lib/services/tracking/uniqueId.js', () => ({ getUniqueId: () => 'device' }));
  vi.doMock(root + '/lib/services/logger.js', () => ({
    default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }));
  const utils = await vi.importActual(root + '/lib/utils.js');
  vi.doMock(root + '/lib/utils.js', () => ({
    ...utils,
    inDevMode: () => false,
    getPackageVersion: async () => '0.0.0-test',
    getProviders: async () => [PORTAL],
  }));

  const { trackJobPriceObservation } = await import(root + '/lib/services/tracking/Tracker.js');
  await trackJobPriceObservation(JOB, [PORTAL]);
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/price'));
}

describe('price observation and currency', () => {
  it('reports nothing for a job whose medians are in francs', async () => {
    expect(await observe('CHF')).toHaveLength(0);
  });

  it('still reports a job whose medians are in euros', async () => {
    expect(await observe('EUR')).toHaveLength(1);
  });

  it('reads a missing currency as euros', async () => {
    expect(await observe(undefined)).toHaveLength(1);
  });
});
