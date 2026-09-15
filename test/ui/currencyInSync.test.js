/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';

import {
  CURRENCY_BY_COUNTRY as backendTable,
  DEFAULT_CURRENCY as backendDefault,
  currencyForCountries as backendForCountries,
  normalizeCurrency as backendNormalize,
} from '../../lib/utils/currency.js';
import {
  CURRENCY_BY_COUNTRY as frontendTable,
  DEFAULT_CURRENCY as frontendDefault,
  currencyForCountries as frontendForCountries,
  normalizeCurrency as frontendNormalize,
} from '../../ui/src/services/price/currency.js';

/**
 * The browser may not import out of lib/, so the country table is written twice. The server stores
 * the currency on every listing and the job form works it out again from the ticked providers; a
 * table that moved on one side only would label a price ceiling in one currency and apply it in
 * another.
 */
describe('currency table in sync between server and browser', () => {
  it('has the same default and the same countries', () => {
    expect(frontendDefault).toBe(backendDefault);
    expect(frontendTable).toEqual(backendTable);
  });

  it.each([[['ch']], [['li']], [['de']], [['es', 'it', 'pt']], [['ch', 'de']], [[]], [null]])(
    'reads %j the same way',
    (countries) => {
      expect(frontendForCountries(countries)).toBe(backendForCountries(countries));
    },
  );

  it.each([['CHF'], ['chf'], ['EUR'], [null], ['francs']])('normalizes %j the same way', (value) => {
    expect(frontendNormalize(value)).toBe(backendNormalize(value));
  });
});
