/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';
import * as mockNotification from './mocks/mockNotification.js';

/**
 * The pipeline tags every new listing with the currency of its country before storing it, so the row
 * is written with it and the notification reads it off the listing. The provider id is the real one:
 * Flatfox declares Switzerland, and that declaration is the whole of what decides francs.
 */
function configFor(listing) {
  return {
    url: 'http://example.com',
    getListings: () => Promise.resolve([listing]),
    normalize: (l) => l,
    filter: () => true,
    crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price' },
    requiredFieldNames: ['id', 'title', 'address', 'price'],
  };
}

const job = { id: 'currency-job', notificationAdapter: [{ id: 'mock' }], specFilter: null, spatialFilter: null };

/**
 * @param {string} providerId
 * @returns {Promise<Object>} The listing after the run.
 */
async function run(providerId) {
  const listing = {
    id: `${providerId}-1`,
    title: 'Wohnung',
    price: 2710,
    link: `https://example.com/${providerId}/1`,
    address: 'Leimgrübelstrasse 22A, 8052 Zürich',
    latitude: 47.42,
    longitude: 8.55,
  };
  const Fredy = await mockFredy();
  const fredy = new Fredy(configFor(listing), job, providerId, { checkAndAddEntry: () => false }, undefined);
  try {
    await fredy.execute();
  } catch {
    // NoNewListingsWarning and friends are control flow here; the steps under test have run.
  }
  return listing;
}

beforeEach(() => {
  mockStore.resetListings();
  mockNotification.reset();
});

describe('the pipeline labels new listings with their currency', () => {
  it('tags a Swiss provider listing as francs and notifies it in francs', async () => {
    const listing = await run('flatfox');
    expect(listing.currency).toBe('CHF');
    expect(mockNotification.get().payload?.[0]?.price).toBe('CHF 2710');
  });

  it('tags a listing of any other provider as euros', async () => {
    const listing = await run('immoscout');
    expect(listing.currency).toBe('EUR');
    expect(mockNotification.get().payload?.[0]?.price).toBe('2710 €');
  });
});
