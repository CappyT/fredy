/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { formatEuroPrice } from './priceService.js';

/**
 * Prices in the currency they were advertised in.
 *
 * Every listing row carries the `currency` the server stored it with, and a row from before
 * currencies existed carries none and is in euros. Nothing is converted: a Swiss rent of 2710 francs
 * is shown as francs, beside a Milanese one in euros.
 *
 * `lib/utils/currency.js` keeps the same table on the server, and `test/ui/currencyInSync.test.js`
 * fails the build when the two disagree.
 */

/** @type {string} */
export const DEFAULT_CURRENCY = 'EUR';

/**
 * ISO 4217 codes for the countries whose currency is not the euro.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CURRENCY_BY_COUNTRY = Object.freeze({
  ch: 'CHF',
  li: 'CHF',
});

/** ISO 4217 alphabetic code. */
const ISO_4217 = /^[A-Z]{3}$/;

/** Built once per locale, currency and precision, like the euro formatters in `priceService.js`. */
const formatterCache = new Map();

/**
 * @param {unknown} value A row's `currency`, or anything else claiming to be one.
 * @returns {string} The upper-cased code, or {@link DEFAULT_CURRENCY} when there is none.
 */
export function normalizeCurrency(value) {
  if (typeof value !== 'string') {
    return DEFAULT_CURRENCY;
  }
  const code = value.trim().toUpperCase();
  return ISO_4217.test(code) ? code : DEFAULT_CURRENCY;
}

/**
 * Whether a price is in euros, the only currency the finance tools can reason about.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDefaultCurrency(value) {
  return normalizeCurrency(value) === DEFAULT_CURRENCY;
}

/**
 * The currency across a set of countries, when they all agree on one.
 *
 * @param {string[]|null|undefined} countries Alpha-2 codes.
 * @returns {string}
 */
export function currencyForCountries(countries) {
  if (!Array.isArray(countries) || countries.length === 0) {
    return DEFAULT_CURRENCY;
  }
  const currencies = new Set(
    countries.map((code) => CURRENCY_BY_COUNTRY[String(code).toLowerCase()] ?? DEFAULT_CURRENCY),
  );
  return currencies.size === 1 ? [...currencies][0] : DEFAULT_CURRENCY;
}

/**
 * The currencies a set of providers advertise in, one per provider rather than one for their union:
 * a job searching a Swiss and a German portal gets francs from the one and euros from the other.
 *
 * @param {Array<{id: string, countries?: string[]}>} providers The `provider` store slice.
 * @param {Iterable<string>} providerIds
 * @returns {string[]} Distinct codes, euros first when present. Empty when no id resolves.
 */
export function currenciesForProviders(providers, providerIds) {
  const byId = new Map((providers ?? []).map((provider) => [provider?.id, provider]));
  const codes = new Set();
  for (const id of providerIds ?? []) {
    if (!byId.has(id)) continue;
    codes.add(currencyForCountries(byId.get(id)?.countries));
  }
  return [...codes].sort((a, b) => (a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a.localeCompare(b)));
}

/**
 * The currencies a set of listing rows is priced in.
 *
 * @param {Array<{currency?: string|null}>} listings Rows as the API returns them.
 * @returns {string[]} Distinct codes, euros first when present. Empty for no rows.
 */
export function currenciesOfListings(listings) {
  const codes = new Set((listings ?? []).map((listing) => normalizeCurrency(listing?.currency)));
  return [...codes].sort((a, b) => (a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a.localeCompare(b)));
}

/**
 * The label that stands for a set of currencies next to a number: `CHF`, or `€ / CHF`.
 *
 * @param {string[]} currencies As {@link currenciesOfListings} or {@link currenciesForProviders} return them.
 * @returns {string} The euro sign when the set is empty.
 */
export function currenciesLabel(currencies) {
  return Array.isArray(currencies) && currencies.length > 0 ? currencies.map(currencyLabel).join(' / ') : '€';
}

/**
 * The short label a currency goes by next to a number in a form: the euro sign, or the code.
 *
 * @param {string} currency
 * @returns {string}
 */
export function currencyLabel(currency) {
  const code = normalizeCurrency(currency);
  return code === DEFAULT_CURRENCY ? '€' : code;
}

/**
 * @param {string} locale
 * @param {string} currency
 * @param {Object} options Extra `Intl.NumberFormat` options.
 * @returns {Intl.NumberFormat}
 */
function formatterFor(locale, currency, options) {
  const key = `${locale}:${currency}:${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (formatter == null) {
    formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, ...options });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/**
 * A price in its own currency, the way the reader's language writes one: `2.710 CHF` in German,
 * `CHF 2,710` in English.
 *
 * Euros go through {@link formatEuroPrice} unchanged, so every euro price reads exactly as it did.
 * Other currencies follow the same rules - cents only when the price has them, a fixed precision when
 * asked for, text handed back as it came.
 *
 * @param {number|string} price
 * @param {string} [locale='de-DE'] BCP 47 locale, from `useLocale()` inside components.
 * @param {string|null} [currency] The row's `currency`; missing means euros.
 * @param {number|null} [fractionDigits=null] Forces an exact number of decimals.
 * @returns {string}
 */
export function formatPrice(price, locale = 'de-DE', currency = DEFAULT_CURRENCY, fractionDigits = null) {
  const code = normalizeCurrency(currency);
  if (code === DEFAULT_CURRENCY) {
    return formatEuroPrice(price, locale, fractionDigits);
  }
  const parsed = Number(price);
  if (!Number.isFinite(parsed)) {
    return `${code} ${price}`;
  }
  const digits = fractionDigits ?? (Number.isInteger(parsed) ? 0 : 2);
  return formatterFor(locale || 'de-DE', code, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(parsed);
}

/**
 * A whole amount that applies in whichever of several currencies a listing turns up in.
 *
 * A job's price ceiling is one number compared against every listing in that listing's own currency,
 * so a job searching a Swiss and a German portal caps the one in francs and the other in euros. One
 * currency formats as a price; several print the number once and name them all, rather than picking
 * one to label it with.
 *
 * @param {number|null|undefined} value
 * @param {string} [locale='de-DE']
 * @param {string[]} [currencies] As {@link currenciesForProviders} returns them.
 * @returns {string} `–` when there is no number.
 */
export function formatPriceInCurrencies(value, locale = 'de-DE', currencies = []) {
  if (!Array.isArray(currencies) || currencies.length <= 1) {
    return formatWholePrice(value, locale, currencies?.[0] ?? DEFAULT_CURRENCY);
  }
  if (value == null || !Number.isFinite(Number(value))) {
    return '–';
  }
  const number = new Intl.NumberFormat(locale || 'de-DE', { maximumFractionDigits: 0 }).format(Number(value));
  return `${number} ${currencies.map(currencyLabel).join(' / ')}`;
}

/**
 * A whole amount in its own currency, for axis labels and tooltips where cents are noise.
 *
 * @param {number|null|undefined} value
 * @param {string} [locale='de-DE']
 * @param {string|null} [currency]
 * @returns {string} `–` when there is no number.
 */
export function formatWholePrice(value, locale = 'de-DE', currency = DEFAULT_CURRENCY) {
  if (value == null || !Number.isFinite(Number(value))) {
    return '–';
  }
  return formatPrice(Math.round(Number(value)), locale, currency);
}
