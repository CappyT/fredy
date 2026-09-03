/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The two orders the instance can render a date in. `MM/DD/YYYY` is what Fredy has always done;
 * `DD/MM/YYYY` is the order the rest of the world writes. Set once per load, from the instance's
 * general settings - every format() call reads the same module state, so a switch repaints the
 * whole interface on the next render without anything else having to know.
 * @type {Record<string, string>}
 */
export const DATE_FORMATS = { DAY_FIRST: 'DD/MM/YYYY', MONTH_FIRST: 'MM/DD/YYYY' };

let dateFormat = DATE_FORMATS.MONTH_FIRST;

/**
 * @param {string|undefined|null} value The stored setting, or anything else for the default.
 * @returns {void}
 */
export function setDateFormat(value) {
  dateFormat = value === DATE_FORMATS.DAY_FIRST ? DATE_FORMATS.DAY_FIRST : DATE_FORMATS.MONTH_FIRST;
}

export function format(ts, showSeconds = true, locale = 'default') {
  const date = new Date(ts);
  // Intl orders the date part by locale, which is exactly what the setting is there to override.
  // The time part keeps following the locale, the way it always has.
  if (!Number.isFinite(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const datePart =
    dateFormat === DATE_FORMATS.DAY_FIRST
      ? `${day}/${month}/${date.getFullYear()}`
      : `${month}/${day}/${date.getFullYear()}`;
  const timePart = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: 'numeric',
    ...(showSeconds ? { second: 'numeric' } : {}),
  }).format(date);
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
