/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  queryListings: vi.fn(() => ({ totalNumber: 0, page: 1, result: [] })),
  getListingById: vi.fn(() => null),
  getListingImage: vi.fn(() => null),
}));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getUserSettings: vi.fn(() => ({})),
}));
vi.mock('../../lib/services/tracking/Tracker.js', () => ({ trackPoi: vi.fn() }));
vi.mock('../../lib/services/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: vi.fn(() => false) }));
vi.mock('../../lib/mcp/mcpAuthentication.js', () => ({
  authenticateToolCall: vi.fn(() => ({ user: { id: 'user-1', isAdmin: false } })),
  checkJobAccess: vi.fn(() => true),
}));

import { queryListings, getListingById } from '../../lib/services/storage/listingsStorage.js';
import { getUserSettings } from '../../lib/services/storage/settingsStorage.js';
import financePlugin from '../../lib/api/routes/financeRouter.js';
import { createMcpServer } from '../../lib/mcp/mcpAdapter.js';
import { normalizeGetListing, normalizeListListings } from '../../lib/mcp/mcpNormalizer.js';

/**
 * The finance model budgets, lends and taxes in euros - a German mortgage, a Bundesland's
 * Grunderwerbsteuer - so a Swiss price has no costing and no verdict. Everywhere a price in francs
 * could reach it, it is kept out rather than scored as though it were euros.
 */
const PROFILE = {
  personA: { label: 'A', enabled: true, age: 34, primaryIncome: 3400, secondaryIncome: 0 },
  personB: { label: 'B', enabled: true, age: 36, primaryIncome: 2400, secondaryIncome: 0 },
  livingCosts: 1400,
  existingDebt: 0,
  existingDebtRate: 0,
  existingDebtInterest: 0,
  renting: { nebenkostenPct: 25 },
  financing: {
    purchasePrice: 400000,
    equity: 80000,
    bundesland: 'NW',
    notaryPct: 1.5,
    maklerPct: 3.57,
    purchasePriceThreshold: 30000,
    scenarios: [{ id: 'mid', annualRate: 3.8, tilgung: 2, fixedYears: 10 }],
  },
};

const listing = (id, price, { dealType = 'buy', currency = null } = {}) => ({
  id,
  price,
  dealType,
  currency,
  title: `Listing ${id}`,
  provider: currency === 'CHF' ? 'flatfox' : 'immoscout',
  link: `https://x/${id}`,
});

async function buildApp() {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: 'user-1' };
  });
  await app.register(financePlugin);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryListings.mockReturnValue({ totalNumber: 0, page: 1, result: [] });
  getUserSettings.mockReturnValue({ finance_profile: PROFILE });
});

describe('finance for listings priced in francs', () => {
  it('leaves a franc listing out of the affordability sweep and counts it as skipped', async () => {
    queryListings.mockReturnValue({
      totalNumber: 3,
      page: 1,
      result: [
        listing('eur', 300000, { currency: 'EUR' }),
        listing('legacy', 320000),
        listing('chf', 300000, { currency: 'CHF' }),
      ],
    });
    const app = await buildApp();

    const body = (await app.inject({ method: 'POST', url: '/affordability', payload: { profile: PROFILE } })).json();

    expect(body.items.map((item) => item.id)).toEqual(['eur', 'legacy']);
    expect(body.skipped).toEqual({ noPrice: 0, incompleteProfile: 0, otherCurrency: 1 });
  });

  it('has no costing for a franc listing', async () => {
    getListingById.mockReturnValue(listing('chf', 300000, { currency: 'CHF' }));
    const app = await buildApp();

    const body = (await app.inject({ method: 'GET', url: '/listing/chf' })).json();

    expect(body.result).toBeNull();
    expect(body.scored).toBeNull();
  });

  it('still costs a euro listing', async () => {
    getListingById.mockReturnValue(listing('eur', 300000, { currency: 'EUR' }));
    const app = await buildApp();

    const body = (await app.inject({ method: 'GET', url: '/listing/eur' })).json();

    expect(body.result.financing.purchasePrice).toBe(300000);
  });

  it('refuses to finance a franc listing through MCP, and says why', async () => {
    getListingById.mockReturnValue(listing('chf', 300000, { currency: 'CHF' }));
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'calculate_financing', arguments: { listingId: 'chf' } });
    await client.close();

    expect(result.content[0].text).toContain('priced in CHF');
    expect(result.content[0].text).toContain('only covers prices in EUR');
  });
});

describe('MCP listings in their currency', () => {
  it('prints the currency next to the price in get_listing', () => {
    const md = normalizeGetListing(listing('chf', 2710, { dealType: 'rent', currency: 'CHF' })).content[0].text;
    expect(md).toContain('- **Price:** CHF 2710 (monthly rent)');
  });

  it('prints the currency in every price cell of list_listings', () => {
    const rows = {
      totalNumber: 2,
      result: [listing('chf', 2710, { currency: 'CHF' }), listing('eur', 900)],
    };
    const md = normalizeListListings(rows, { page: 1, pageSize: 50 }).content[0].text;
    expect(md).toContain('| CHF 2710 |');
    expect(md).toContain('| 900 € |');
  });
});
