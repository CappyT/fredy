/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The two orders the instance can pin a date to. Set once per load, from the instance's general
 * settings - every format() call reads the same module state, so a switch repaints the whole
 * interface on the next render without anything else having to know.
 * @type {Record<string, string>}
 */
export const DATE_FORMATS = { DAY_FIRST: 'DD/MM/YYYY', MONTH_FIRST: 'MM/DD/YYYY' };

/**
 * The order in force, or null for the language's own.
 *
 * Null is the shipped state and has to stay it. Before the setting existed the order came from
 * `Intl.DateTimeFormat(locale)`, so a German instance read `10.9.2026` and a Turkish one
 * `10.09.2026`; defaulting the unset setting to either pattern would flip every one of those
 * installations to the other order on upgrade, and leave the operator hunting for a setting they
 * never asked for. Nothing on the server fills this in either - the setting is absent until an
 * admin picks an order - so absent has to mean what it meant before.
 * @type {string|null}
 */
let dateFormat = null;

/**
 * @param {string|undefined|null} value The stored setting. Anything that is not one of the two
 *   orders - absent, empty, a pattern from a newer release - hands the date back to the locale.
 * @returns {void}
 */
export function setDateFormat(value) {
  dateFormat = value === DATE_FORMATS.DAY_FIRST || value === DATE_FORMATS.MONTH_FIRST ? value : null;
}

export function format(ts, showSeconds = true, locale = 'default') {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return '';
  const timeOptions = {
    hour: 'numeric',
    minute: 'numeric',
    ...(showSeconds ? { second: 'numeric' } : {}),
  };
  // Intl orders the date part by locale, which is exactly what the setting is there to override -
  // and, while no order is set, exactly what should still happen.
  if (dateFormat == null) {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      ...timeOptions,
    }).format(date);
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const datePart =
    dateFormat === DATE_FORMATS.DAY_FIRST
      ? `${day}/${month}/${date.getFullYear()}`
      : `${month}/${day}/${date.getFullYear()}`;
  // The time part keeps following the locale, the way it always has.
  const timePart = new Intl.DateTimeFormat(locale, timeOptions).format(date);
  return `${datePart}, ${timePart}`;
}

/**
 * The IANA zones this browser knows, as Select options, with the stored one folded in.
 *
 * Two things this has to survive. `Intl.supportedValuesOf` is missing on older browsers, which
 * would otherwise leave the operator with an empty dropdown and no way to see or keep their
 * setting. And a value saved on the server may be a name the browser's list does not carry -
 * `US/Eastern` and the other legacy names resolve everywhere but are not listed - where a Select
 * silently renders nothing for a value that has no matching option, making a configured zone look
 * unset.
 *
 * @param {string|null} [current] The stored zone.
 * @returns {{value: string, label: string}[]} Sorted options.
 */
export function timeZoneOptions(current) {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const zones = new Set(supported.length > 0 ? supported : ['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone]);
  if (typeof current === 'string' && current.length > 0) {
    zones.add(current);
  }
  return [...zones].sort().map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}
