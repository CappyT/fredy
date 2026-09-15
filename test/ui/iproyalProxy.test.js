/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';

import {
  countriesFromProviders,
  isIproyalProxy,
  randomSessionId,
  readIproyalOptions,
  writeIproyalOptions,
} from '../../ui/src/services/proxy/iproyal.js';

const ROTATING = 'http://user:Z0hdfdVpeZtOqCIv@geo.iproyal.com:12321';
const STICKY = 'http://user:Z0hdfdVpeZtOqCIv_country-ch_session-hFtcrtN8_lifetime-5m@geo.iproyal.com:12321';

describe('isIproyalProxy', () => {
  it('knows its own host', () => {
    expect(isIproyalProxy(ROTATING)).toBe(true);
    expect(isIproyalProxy('socks5://user:pass@socks.iproyal.com:32325')).toBe(true);
  });

  it('leaves every other proxy alone', () => {
    expect(isIproyalProxy('http://user:pass@proxy.webshare.io:80')).toBe(false);
    expect(isIproyalProxy('http://user:pass@notiproyal.com.example:80')).toBe(false);
    expect(isIproyalProxy('http://geo.iproyal.com:12321')).toBe(false);
    expect(isIproyalProxy('')).toBe(false);
  });
});

/**
 * The settings page renders the country, rotation and lifetime controls on `readIproyalOptions()`
 * answering with something. Nothing else decides it, so what that function calls an IPRoyal url is
 * exactly what the operator sees the controls for - including the half-typed urls a field produces
 * on the way to a finished one.
 */
describe('the controls appear for IPRoyal and for nothing else', () => {
  it.each([
    ['nothing configured', ''],
    ['whitespace', '   '],
    ['no value at all', null],
    ['another provider', 'http://user:pass@proxy.webshare.io:80'],
    ['a provider whose name ends the same way', 'http://user:pass@iproyal.com.evil.example:80'],
    ['IPRoyal without credentials, which has no password to write into', 'http://geo.iproyal.com:12321'],
    ['a username but no password', 'http://user@geo.iproyal.com:12321'],
    ['a url still being typed', 'http://user:pass@iproy'],
    ['a host with no scheme', 'geo.iproyal.com:12321'],
  ])('stays hidden for %s', (_case, proxyUrl) => {
    expect(readIproyalOptions(proxyUrl)).toBe(null);
  });

  it.each([
    ['the plain http endpoint', ROTATING],
    ['a password that already carries options', STICKY],
    ['the socks endpoint', 'socks5://user:pass@socks.iproyal.com:32325'],
    ['a host written in capitals', 'http://user:pass@GEO.IPROYAL.COM:12321'],
    ['a value with whitespace around it', `  ${ROTATING}  `],
  ])('appears for %s', (_case, proxyUrl) => {
    expect(readIproyalOptions(proxyUrl)).not.toBe(null);
  });
});

describe('readIproyalOptions', () => {
  it('reads the example off a sticky password', () => {
    expect(readIproyalOptions(STICKY)).toEqual({
      country: 'ch',
      sticky: true,
      sessionId: 'hFtcrtN8',
      ttlMinutes: 5,
    });
  });

  it('reads a bare password as rotating', () => {
    expect(readIproyalOptions(ROTATING)).toEqual({
      country: null,
      sticky: false,
      sessionId: null,
      ttlMinutes: null,
    });
  });

  it('converts a lifetime written in another unit', () => {
    const inHours = 'http://user:pw_session-abc_lifetime-2h@geo.iproyal.com:12321';
    expect(readIproyalOptions(inHours).ttlMinutes).toBe(120);
  });

  it('says nothing about a proxy that is not IPRoyal', () => {
    expect(readIproyalOptions('http://user:pass@proxy.webshare.io:80')).toBe(null);
  });
});

describe('writeIproyalOptions', () => {
  it('turns a rotating proxy into a sticky one', () => {
    const written = writeIproyalOptions(ROTATING, {
      country: 'ch',
      sticky: true,
      sessionId: 'hFtcrtN8',
      ttlMinutes: 5,
    });
    expect(written).toBe(STICKY);
  });

  it('drops the session and the lifetime when it goes back to rotating', () => {
    const written = writeIproyalOptions(STICKY, { country: 'ch', sticky: false });
    expect(written).toBe('http://user:Z0hdfdVpeZtOqCIv_country-ch@geo.iproyal.com:12321');
  });

  it('drops the country when none is picked', () => {
    const written = writeIproyalOptions(STICKY, { sticky: true, sessionId: 'hFtcrtN8', ttlMinutes: 5 });
    expect(written).toBe('http://user:Z0hdfdVpeZtOqCIv_session-hFtcrtN8_lifetime-5m@geo.iproyal.com:12321');
  });

  it('keeps the pieces the form knows nothing about, where they were', () => {
    const handWritten = 'http://user:pw_city-zurich_country-de_streaming-1@geo.iproyal.com:12321';
    const written = writeIproyalOptions(handWritten, { country: 'ch', sticky: false });
    expect(written).toBe('http://user:pw_city-zurich_country-ch_streaming-1@geo.iproyal.com:12321');
  });

  it('mints a session id when sticky is asked for without one', () => {
    const written = writeIproyalOptions(ROTATING, { sticky: true, ttlMinutes: 10 });
    expect(written).toMatch(
      /^http:\/\/user:Z0hdfdVpeZtOqCIv_session-[A-Za-z0-9]{8}_lifetime-10m@geo\.iproyal\.com:12321$/,
    );
  });

  it('survives a round trip', () => {
    const options = { country: 'it', sticky: true, sessionId: 'abcd1234', ttlMinutes: 30 };
    expect(readIproyalOptions(writeIproyalOptions(ROTATING, options))).toEqual(options);
  });

  it('leaves a proxy that is not IPRoyal exactly as it was', () => {
    const other = 'http://user:pass@proxy.webshare.io:80';
    expect(writeIproyalOptions(other, { country: 'ch', sticky: true })).toBe(other);
  });
});

describe('randomSessionId', () => {
  it('is eight letters and digits, and not the same twice', () => {
    expect(randomSessionId()).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(randomSessionId()).not.toBe(randomSessionId());
  });
});

describe('countriesFromProviders', () => {
  it('folds the declared countries into one sorted list', () => {
    const providers = [{ countries: ['de', 'at'] }, { countries: ['IT'] }, { countries: ['de'] }, {}];
    expect(countriesFromProviders(providers)).toEqual(['at', 'de', 'it']);
  });

  it('answers with nothing when no provider declares a country', () => {
    expect(countriesFromProviders([])).toEqual([]);
    expect(countriesFromProviders(undefined)).toEqual([]);
  });
});
