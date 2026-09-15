/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Which currency a price is written in, and how a notification writes it.
 *
 * A price is a bare number everywhere in Fredy, and for most of its providers that number is euros.
 * Flatfox is the exception: its adverts are Swiss, and a rent of `2710` there is 2710 francs. Nothing
 * converts one into the other - an exchange rate would need a service to ask and would go stale on
 * the row - so a franc stays a franc and is labelled as one, and the places that compare prices
 * compare only prices in the same currency.
 *
 * The currency follows the country a listing is in, which is the one thing every provider already
 * declares. Deliberately free of imports, like `countries.js`, so the notification formatter can read
 * it without loading the provider modules.
 *
 * `ui/src/services/price/currency.js` keeps the same table for the browser, and
 * `test/ui/currencyInSync.test.js` fails the build when the two disagree.
 */

/**
 * The currency of a listing nothing says otherwise about. Also what a stored row with no currency
 * yet reads as: every such row was found before currencies existed, when every price was taken to
 * be euros.
 *
 * @type {string}
 */
export const DEFAULT_CURRENCY = 'EUR';

/**
 * ISO 4217 codes for the countries whose currency is not the euro. A country missing here pays in
 * euros, which covers every other country a shipped provider serves.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CURRENCY_BY_COUNTRY = Object.freeze({
  ch: 'CHF',
  li: 'CHF',
});

/** ISO 4217 alphabetic code. */
const ISO_4217 = /^[A-Z]{3}$/;

/**
 * Read whatever a row or a request carries into a currency code.
 *
 * @param {unknown} value A stored `currency` column, or anything else claiming to be one.
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
 * Whether a price is in the default currency, which is the only one the finance model and the
 * external price observations know how to read.
 *
 * @param {unknown} value A stored `currency` column; a missing one is the default.
 * @returns {boolean}
 */
export function isDefaultCurrency(value) {
  return normalizeCurrency(value) === DEFAULT_CURRENCY;
}

/**
 * The currency prices are written in across a set of countries.
 *
 * Only an answer every country agrees on counts. A provider serving a franc country and a euro
 * country at once could be quoting either, and guessing francs would relabel its euro adverts; such
 * a provider has to narrow each listing to one country (`countryOf`) before it gets anything but the
 * default.
 *
 * @param {string[]|null|undefined} countries Alpha-2 codes, as `normalizeCountries` returns them.
 * @returns {string} ISO 4217 code.
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
 * Write an amount the way a notification shows it.
 *
 * Euros keep the exact shape notifications have always had (`1200 €`), so nothing an adapter or a
 * downstream consumer of the http adapter parses changes for them. Every other currency leads with
 * its code (`CHF 2710`), which is how Swiss adverts write a price.
 *
 * @param {number|string|null|undefined} amount
 * @param {string|null|undefined} currency ISO 4217 code; anything else reads as the default.
 * @returns {string|null} `null` when there is no amount.
 */
export function formatAmount(amount, currency) {
  if (amount == null) {
    return null;
  }
  const code = normalizeCurrency(currency);
  return code === DEFAULT_CURRENCY ? `${amount} €` : `${code} ${amount}`;
}
