/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';

import {
  isIproyalProxy as backendIsIproyal,
  randomSessionId as backendSessionId,
  readIproyalOptions as backendRead,
  writeIproyalOptions as backendWrite,
} from '../../lib/services/proxy/iproyal.js';
import {
  isIproyalProxy as frontendIsIproyal,
  randomSessionId as frontendSessionId,
  readIproyalOptions as frontendRead,
  writeIproyalOptions as frontendWrite,
} from '../../ui/src/services/proxy/iproyal.js';

/**
 * The browser may not import out of lib/, so the IPRoyal password rules are written twice.
 *
 * Both copies rewrite the same saved password: the settings form writes the country, the sticky
 * switch and the lifetime, and the scraper writes a new session id to leave from another exit node.
 * A rule that moved on one side only would send a job out through a country nobody picked, and
 * nothing would fail - IPRoyal answers a malformed suffix with a working proxy in the wrong place.
 */
const PASSWORDS = [
  'http://user:secret_country-it_session-hFtcrtN8_lifetime-5m@geo.iproyal.com:12321',
  'http://user:secret_country-ch@geo.iproyal.com:12321',
  'http://user:secret@geo.iproyal.com:12321',
  // The pieces neither caller owns have to survive both of them, in the place they were written in.
  'http://user:secret_city-milan_country-it_streaming-1_session-abc_lifetime-30m@geo.iproyal.com:12321',
  'http://user:secret_lifetime-2h@residential.iproyal.com:12321',
  'socks5://user:secret_country-de_session-x@geo.iproyal.com:32325',
  'http://user:secret@proxy.example.com:8080',
  'not a url at all',
  '',
];

/** The rewrites the two callers make between them. */
const PATCHES = [
  { sticky: true, sessionId: 'newSess1', ttlMinutes: 5 },
  { sticky: true, sessionId: 'newSess1', country: 'ch', ttlMinutes: 30 },
  { sticky: false, country: 'it' },
  { sticky: false },
  { country: 'pt', sticky: true, sessionId: 'z', ttlMinutes: null },
];

describe('IPRoyal password rules in sync between server and browser', () => {
  it.each(PASSWORDS)('recognises %j the same way', (proxyUrl) => {
    expect(frontendIsIproyal(proxyUrl)).toBe(backendIsIproyal(proxyUrl));
  });

  it.each(PASSWORDS)('reads %j the same way', (proxyUrl) => {
    expect(frontendRead(proxyUrl)).toEqual(backendRead(proxyUrl));
  });

  it.each(PASSWORDS.flatMap((proxyUrl) => PATCHES.map((patch) => [proxyUrl, patch])))(
    'writes %j the same way for %j',
    (proxyUrl, patch) => {
      expect(frontendWrite(proxyUrl, patch)).toBe(backendWrite(proxyUrl, patch));
    },
  );

  /** A round trip is what the settings page does on every keystroke, and the scraper on a refusal. */
  it.each(PASSWORDS)('round trips %j the same way', (proxyUrl) => {
    const rewrite = (read, write) => {
      const options = read(proxyUrl);
      return options == null ? proxyUrl : write(proxyUrl, { ...options, sessionId: 'pinned' });
    };
    expect(rewrite(frontendRead, frontendWrite)).toBe(rewrite(backendRead, backendWrite));
  });

  /** The id itself is random, so only its shape can agree. */
  it('mints session ids of the same shape', () => {
    expect(frontendSessionId()).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(backendSessionId()).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});
