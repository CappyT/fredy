/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { countriesForListing } from './countries.js';
import { getCountriesForListing } from './providerCountries.js';
import { currencyForCountries } from '../../utils/currency.js';

/**
 * The currency of one listing, read off the country its provider places it in.
 *
 * Synchronous, for a caller that already holds the provider's `metaInformation` - the startup
 * backfill walks the loaded modules itself.
 *
 * @param {{countries?: unknown, countryOf?: Function}|null|undefined} meta The provider's `metaInformation`.
 * @param {any} listing The listing, for a provider that narrows its countries per listing.
 * @returns {string} ISO 4217 code.
 */
export function currencyForListing(meta, listing) {
  return currencyForCountries(countriesForListing(meta, listing));
}

/**
 * The currency of one listing found by a provider, resolved against the loaded provider modules.
 *
 * Per listing rather than per provider for the same reason geocoding is: the country is the input,
 * and a provider covering several markets may narrow it for each advert. An id matching no loaded
 * provider reads as the default country, and so as the default currency.
 *
 * @param {string|null|undefined} providerId
 * @param {any} listing
 * @returns {Promise<string>} ISO 4217 code.
 */
export async function getCurrencyForListing(providerId, listing) {
  return currencyForCountries(await getCountriesForListing(providerId, listing));
}
