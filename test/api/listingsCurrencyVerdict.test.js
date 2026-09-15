/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  queryListings: vi.fn(() => ({ totalNumber: 0, page: 1, result: [] })),
  getAvailableProviders: vi.fn(() => []),
  getListingsForMap: vi.fn(() => []),
  getListingById: vi.fn(() => null),
}));
vi.mock('../../lib/services/storage/watchListStorage.js', () => ({ toggleWatch: vi.fn(), ensureWatch: vi.fn() }));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({ getJob: vi.fn(() => null) }));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: vi.fn(async () => ({})),
  getUserSettings: vi.fn(() => ({})),
}));
vi.mock('../../lib/services/tracking/Tracker.js', () => ({ trackPoi: vi.fn() }));
vi.mock('../../lib/services/logger.js', () => ({ default: { error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: vi.fn(() => false) }));

import { queryListings, getListingById } from '../../lib/services/storage/listingsStorage.js';
import { getUserSettings } from '../../lib/services/storage/settingsStorage.js';
import listingsPlugin from '../../lib/api/routes/listingsRouter.js';

/**
 * The verdict chip is decided on the server against the user's profile, whose thresholds are euros.
 * A franc listing gets no verdict at all - not "affordable", which a rent of 900 francs would
 * otherwise read as against a euro ceiling.
 */
const PROFILE = {
  personA: { label: 'A', enabled: true, age: 34, primaryIncome: 3400, secondaryIncome: 0 },
  livingCosts: 1200,
  existingDebtRate: 0,
  renting: { nebenkostenPct: 25 },
  financing: {
    equity: 60000,
    bundesland: 'NW',
    notaryPct: 1.5,
    maklerPct: 3.57,
    purchasePriceThreshold: 30000,
    scenarios: [{ id: 'mid', annualRate: 3.8, tilgung: 2, fixedYears: 10 }],
  },
};

async function buildApp() {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: 'user-1' };
  });
  await app.register(listingsPlugin);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserSettings.mockReturnValue({ finance_profile: PROFILE });
});

describe('affordability verdicts and currency', () => {
  it('gives the overview rows a verdict only when they are priced in euros', async () => {
    queryListings.mockReturnValue({
      totalNumber: 3,
      page: 1,
      result: [
        { id: 'chf', price: 900, dealType: 'rent', currency: 'CHF' },
        { id: 'eur', price: 900, dealType: 'rent', currency: 'EUR' },
        { id: 'legacy', price: 900, dealType: 'rent', currency: null },
      ],
    });
    const app = await buildApp();

    const body = (await app.inject({ method: 'GET', url: '/table' })).json();
    const verdicts = Object.fromEntries(body.result.map((row) => [row.id, row.affordabilityVerdict]));

    expect(verdicts.chf).toBeNull();
    expect(verdicts.eur).not.toBeNull();
    expect(verdicts.legacy).toBe(verdicts.eur);
  });

  it('gives the listing detail no verdict when it is priced in francs', async () => {
    getListingById.mockReturnValue({ id: 'chf', price: 900, dealType: 'rent', currency: 'CHF' });
    const app = await buildApp();

    const body = (await app.inject({ method: 'GET', url: '/chf' })).json();

    expect(body.currency).toBe('CHF');
    expect(body.affordabilityVerdict).toBeNull();
  });
});
