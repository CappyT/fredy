/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { formatListing, formatPriceChange } from '../../lib/utils/formatListing.js';

/**
 * Every notification adapter prints the price string it is handed, so this is the one place a Swiss
 * rent can be labelled as francs for all of them at once.
 */
describe('notification prices in the listing currency', () => {
  const listing = { id: 'l1', title: 'Wohnung', price: 2710, size: 70, rooms: 3 };

  it('labels a franc listing in francs', () => {
    expect(formatListing({ ...listing, currency: 'CHF' }, 'en').price).toBe('2.710 CHF');
  });

  it('leaves a euro listing, and one with no currency, exactly as before', () => {
    expect(formatListing({ ...listing, currency: 'EUR' }, 'en').price).toBe('2.710 €');
    expect(formatListing(listing, 'en').price).toBe('2.710 €');
  });

  it('writes both halves of a price change in the listing currency', () => {
    const change = {
      listing: { ...listing, currency: 'CHF' },
      oldPrice: 2900,
      newPrice: 2710,
      changePercent: -6.55,
      direction: 'down',
    };
    const formatted = formatPriceChange(change, 'en');
    expect(formatted.oldPrice).toBe('2.900 CHF');
    expect(formatted.newPrice).toBe('2.710 CHF');
    expect(formatted.price).toBe('2.710 CHF');
  });

  it('keeps euro price changes unchanged', () => {
    const change = { listing, oldPrice: 1200, newPrice: 1100, changePercent: -8.3, direction: 'down' };
    const formatted = formatPriceChange(change, 'en');
    expect(formatted.oldPrice).toBe('1.200 €');
    expect(formatted.newPrice).toBe('1.100 €');
  });
});
