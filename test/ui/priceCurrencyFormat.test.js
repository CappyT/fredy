/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { formatEuroPrice } from '../../ui/src/services/price/priceService.js';
import {
  currenciesForProviders,
  currenciesLabel,
  currenciesOfListings,
  currencyLabel,
  formatPrice,
  formatPriceInCurrencies,
  formatWholePrice,
  isDefaultCurrency,
} from '../../ui/src/services/price/currency.js';
import { formatPricePerSqm, readMarketBenchmark } from '../../ui/src/services/listings/marketBenchmark.js';

/** `Intl` puts a narrow no-break space between amount and symbol; see priceFormat.test.js. */
const normalize = (value) => value.replace(/[\u00a0\u202f]/g, ' ');

describe('prices in the listing currency', () => {
  describe('formatPrice', () => {
    it('writes a euro price exactly the way formatEuroPrice does', () => {
      for (const price of [776515, 1016, 1016.5, 'auf Anfrage']) {
        expect(formatPrice(price, 'de-DE', 'EUR')).toBe(formatEuroPrice(price, 'de-DE'));
        expect(formatPrice(price, 'en-US', null)).toBe(formatEuroPrice(price, 'en-US'));
      }
    });

    it('writes a franc price with the franc code, in the reader locale', () => {
      expect(normalize(formatPrice(2710, 'de-DE', 'CHF'))).toBe('2.710 CHF');
      expect(normalize(formatPrice(2710, 'en-US', 'CHF'))).toBe('CHF 2,710');
    });

    it('keeps the cents a franc price actually has, and only those', () => {
      expect(normalize(formatPrice(1016.5, 'de-DE', 'CHF'))).toBe('1.016,50 CHF');
      expect(normalize(formatPrice(13, 'de-DE', 'CHF', 2))).toBe('13,00 CHF');
    });

    it('hands text back with the code rather than printing NaN', () => {
      expect(formatPrice('auf Anfrage', 'de-DE', 'CHF')).toBe('CHF auf Anfrage');
    });
  });

  describe('formatWholePrice', () => {
    it('rounds away the cents and keeps the currency', () => {
      expect(normalize(formatWholePrice(2710.4, 'de-DE', 'CHF'))).toBe('2.710 CHF');
      expect(formatWholePrice(null, 'de-DE', 'CHF')).toBe('–');
    });
  });

  describe('formatPricePerSqm', () => {
    it('labels a franc quotient in francs', () => {
      expect(normalize(formatPricePerSqm(38.71, 'de-DE', true, 'CHF'))).toBe('38,71 CHF/m²');
    });

    it('keeps euro quotients unchanged when no currency is given', () => {
      expect(normalize(formatPricePerSqm(12.4, 'de-DE'))).toBe('12,40 €/m²');
    });
  });

  it('carries the listing currency through the benchmark reading', () => {
    expect(readMarketBenchmark({ price_per_sqm: 38.7, currency: 'CHF' }).currency).toBe('CHF');
    expect(readMarketBenchmark({ price_per_sqm: 12.4 }).currency).toBeNull();
  });

  describe('the map price filter', () => {
    it('names the currencies the listings on the map are in', () => {
      expect(currenciesLabel(currenciesOfListings([{ currency: 'CHF' }, { currency: 'CHF' }]))).toBe('CHF');
      expect(currenciesLabel(currenciesOfListings([{ currency: 'CHF' }, { currency: null }]))).toBe('€ / CHF');
    });

    it('keeps the euro sign for an empty map', () => {
      expect(currenciesLabel(currenciesOfListings([]))).toBe('€');
    });
  });

  describe('the job form', () => {
    const providers = [
      { id: 'flatfox', countries: ['ch'] },
      { id: 'immobiliare', countries: ['it'] },
      { id: 'idealista', countries: ['es', 'it', 'pt'] },
    ];

    it('names francs for a search on a Swiss portal only', () => {
      expect(currenciesForProviders(providers, ['flatfox'])).toEqual(['CHF']);
    });

    it('names each currency once, euros first, for a search across the border', () => {
      expect(currenciesForProviders(providers, ['flatfox', 'immobiliare', 'idealista'])).toEqual(['EUR', 'CHF']);
    });

    it('ignores a provider that no longer exists', () => {
      expect(currenciesForProviders(providers, ['gone'])).toEqual([]);
    });

    it('labels the ceiling in the one currency it applies in', () => {
      expect(normalize(formatPriceInCurrencies(3000, 'de-DE', ['CHF']))).toBe('3.000 CHF');
      expect(normalize(formatPriceInCurrencies(3000, 'de-DE', []))).toBe('3.000 €');
    });

    it('prints the number once and names every currency when a ceiling applies in several', () => {
      expect(formatPriceInCurrencies(3000, 'de-DE', ['EUR', 'CHF'])).toBe('3.000 € / CHF');
    });

    it('uses the euro sign and the franc code as the field suffix', () => {
      expect(currencyLabel('EUR')).toBe('€');
      expect(currencyLabel('CHF')).toBe('CHF');
      expect(isDefaultCurrency(undefined)).toBe(true);
    });
  });
});
