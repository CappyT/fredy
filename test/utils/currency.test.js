/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURRENCY,
  currencyForCountries,
  formatAmount,
  isDefaultCurrency,
  normalizeCurrency,
} from '../../lib/utils/currency.js';
import { currencyForListing } from '../../lib/services/providers/providerCurrency.js';

/**
 * The currency a price is written in follows the country of the listing, and nothing is converted.
 * Every case below either holds the euro default or names the one country table that overrides it.
 */
describe('lib/utils/currency', () => {
  describe('currencyForCountries', () => {
    it('reads francs off Switzerland and Liechtenstein', () => {
      expect(currencyForCountries(['ch'])).toBe('CHF');
      expect(currencyForCountries(['li'])).toBe('CHF');
      expect(currencyForCountries(['ch', 'li'])).toBe('CHF');
    });

    it('reads euros off every other country a provider serves', () => {
      expect(currencyForCountries(['de'])).toBe('EUR');
      expect(currencyForCountries(['es', 'it', 'pt'])).toBe('EUR');
      expect(currencyForCountries(['at'])).toBe('EUR');
    });

    it('does not guess francs for a provider serving a franc and a euro country at once', () => {
      // Labelling that provider's euro adverts as francs would be the wrong half of the guess; it has
      // to narrow each listing to one country before it gets anything but the default.
      expect(currencyForCountries(['ch', 'de'])).toBe(DEFAULT_CURRENCY);
    });

    it('falls back to the default when there is nothing to read', () => {
      expect(currencyForCountries([])).toBe(DEFAULT_CURRENCY);
      expect(currencyForCountries(null)).toBe(DEFAULT_CURRENCY);
      expect(currencyForCountries(undefined)).toBe(DEFAULT_CURRENCY);
    });

    it('does not care how the codes are cased', () => {
      expect(currencyForCountries(['CH'])).toBe('CHF');
    });
  });

  describe('normalizeCurrency and isDefaultCurrency', () => {
    it('reads a stored code, whatever its case', () => {
      expect(normalizeCurrency('chf')).toBe('CHF');
      expect(normalizeCurrency(' EUR ')).toBe('EUR');
    });

    it('reads a row from before currencies existed as euros', () => {
      expect(normalizeCurrency(null)).toBe('EUR');
      expect(normalizeCurrency(undefined)).toBe('EUR');
      expect(isDefaultCurrency(null)).toBe(true);
    });

    it('does not take anything that is not an ISO 4217 code for one', () => {
      expect(normalizeCurrency('francs')).toBe('EUR');
      expect(normalizeCurrency(42)).toBe('EUR');
    });

    it('tells francs apart from the default', () => {
      expect(isDefaultCurrency('CHF')).toBe(false);
      expect(isDefaultCurrency('EUR')).toBe(true);
    });
  });

  describe('formatAmount', () => {
    it('keeps the shape euro notifications have always had', () => {
      expect(formatAmount(1200, 'EUR')).toBe('1200 €');
      expect(formatAmount(1200, null)).toBe('1200 €');
    });

    it('leads with the code for any other currency, the way a Swiss advert writes it', () => {
      expect(formatAmount(2710, 'CHF')).toBe('CHF 2710');
    });

    it('has nothing to say without an amount', () => {
      expect(formatAmount(null, 'CHF')).toBeNull();
      expect(formatAmount(undefined, 'EUR')).toBeNull();
    });
  });

  describe('currencyForListing', () => {
    it('follows the provider declaration', () => {
      expect(currencyForListing({ id: 'flatfox', countries: ['ch'] }, {})).toBe('CHF');
      expect(currencyForListing({ id: 'immobiliare', countries: ['it'] }, {})).toBe('EUR');
    });

    it('follows the country a multi-market provider narrows a listing to', () => {
      const meta = {
        id: 'alpine',
        countries: ['ch', 'de'],
        countryOf: (listing) => (String(listing.link).includes('.ch/') ? 'ch' : 'de'),
      };
      expect(currencyForListing(meta, { link: 'https://alpine.ch/1' })).toBe('CHF');
      expect(currencyForListing(meta, { link: 'https://alpine.de/1' })).toBe('EUR');
    });

    it('reads a provider that is no longer loaded as the default', () => {
      expect(currencyForListing(undefined, {})).toBe(DEFAULT_CURRENCY);
    });
  });
});
