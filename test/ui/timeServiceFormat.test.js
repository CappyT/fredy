/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, afterEach } from 'vitest';
import { format, setDateFormat, DATE_FORMATS } from '../../ui/src/services/time/timeService.js';

/**
 * The date order the instance sets, and what every date in the interface reads like because of it.
 *
 * Two states, not one. While no order is set - which is every installation until an admin picks one
 * - the date is handed to `Intl.DateTimeFormat(locale)`, the way it was before this setting existed:
 * a German reads `3.9.2026` and an American `9/3/2026`. Once an order is set it is written by hand,
 * because Intl orders the date parts by locale and that is precisely what the setting overrides. The
 * time half follows the locale either way, so only the date order is pinned here.
 */

/** A fixed instant: 2026-09-03 20:41:07 UTC. */
const TS = Date.UTC(2026, 8, 3, 20, 41, 7);

/** The same instant as the machine running the test reads it, which is what format() renders. */
const local = new Date(TS);
const day = local.getDate();
const month = local.getMonth() + 1;

describe('the date format the instance sets', () => {
  afterEach(() => {
    setDateFormat(null);
  });

  it('leaves the order to the language while the instance has not chosen one', () => {
    // The regression this guards: a month-first default here moved every German, Turkish and
    // Italian instance off its users' own order on upgrade, with nothing on the server setting the
    // value and no clue in the interface beyond a setting nobody had opened.
    setDateFormat(undefined);

    expect(format(TS, false, 'de-DE')).toMatch(new RegExp(`^${day}\\.${month}\\.2026, `));
    expect(format(TS, false, 'en-US')).toMatch(new RegExp(`^${month}/${day}/2026, `));
  });

  it('renders month first when the instance says so', () => {
    setDateFormat(DATE_FORMATS.MONTH_FIRST);
    expect(format(TS, false, 'en-US')).toMatch(/^09\/03\/2026, /);
    // The pinned order is the same for everybody, whatever their language writes.
    expect(format(TS, false, 'de-DE')).toMatch(/^09\/03\/2026, /);
  });

  it('renders day first when the instance says so', () => {
    setDateFormat(DATE_FORMATS.DAY_FIRST);
    expect(format(TS, false, 'en-US')).toMatch(/^03\/09\/2026, /);
  });

  it('keeps zero padding in both orders', () => {
    const early = Date.UTC(2026, 0, 5, 12, 2, 3);
    setDateFormat(DATE_FORMATS.DAY_FIRST);
    expect(format(early, false, 'en-US')).toMatch(/^05\/01\/2026/);
    setDateFormat(DATE_FORMATS.MONTH_FIRST);
    expect(format(early, false, 'en-US')).toMatch(/^01\/05\/2026/);
  });

  it('hands an order it does not recognise back to the language', () => {
    // An empty value is the setting's own "follow the language", and a pattern from a release this
    // browser has not caught up with must not be guessed at either.
    for (const value of ['', 'YYYY/DD/MM']) {
      setDateFormat(value);
      expect(format(TS, false, 'de-DE')).toMatch(new RegExp(`^${day}\\.${month}\\.2026, `));
    }
  });

  it('renders nothing for a timestamp that is not a date', () => {
    expect(format(undefined)).toBe('');
    setDateFormat(DATE_FORMATS.DAY_FIRST);
    expect(format(undefined)).toBe('');
  });
});
