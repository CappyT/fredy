/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, afterEach } from 'vitest';
import { format, setDateFormat, DATE_FORMATS } from '../../ui/src/services/time/timeService.js';

/**
 * The date order the instance sets, and what every date in the interface reads like because of it.
 *
 * The format is written by hand rather than handed to Intl, because Intl orders the date parts by
 * locale - which is precisely the thing the setting exists to override. The time half keeps
 * following the locale, so only the date order is pinned here.
 */

/** A fixed instant: 2026-09-03 20:41:07 UTC. */
const TS = Date.UTC(2026, 8, 3, 20, 41, 7);

describe('the date format the instance sets', () => {
  afterEach(() => {
    setDateFormat(DATE_FORMATS.MONTH_FIRST);
  });

  it('renders month first, which is what the interface has always done', () => {
    setDateFormat(DATE_FORMATS.MONTH_FIRST);
    expect(format(TS, false, 'en-US')).toMatch(/^09\/03\/2026, /);
  });

  it('renders day first when the instance says so', () => {
    setDateFormat(DATE_FORMATS.DAY_FIRST);
    expect(format(TS, false, 'en-US')).toMatch(/^03\/09\/2026, /);
  });

  it('keeps zero padding in both orders', () => {
    const early = Date.UTC(2026, 0, 5, 1, 2, 3);
    setDateFormat(DATE_FORMATS.DAY_FIRST);
    expect(format(early, false, 'en-US')).toMatch(/^05\/01\/2026/);
    setDateFormat(DATE_FORMATS.MONTH_FIRST);
    expect(format(early, false, 'en-US')).toMatch(/^01\/05\/2026/);
  });

  it('falls back to month first on anything the setting does not name', () => {
    setDateFormat('YYYY/DD/MM');
    expect(format(TS, false, 'en-US')).toMatch(/^09\/03\/2026/);
  });

  it('renders nothing for a timestamp that is not a date', () => {
    expect(format(undefined)).toBe('');
  });
});
