/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataDomeCookieStore } from '../../../lib/services/datadome/cookieStore.js';

let directory;
let store;
const cookie = (fields = {}) => ({
  name: 'datadome',
  value: 'test-cookie',
  domain: '.immobiliare.it',
  path: '/',
  expires: Date.now() / 1000 + 3600,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  ...fields,
});

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'fredy-cookie-test-'));
  store = new DataDomeCookieStore(directory);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe('DataDome disk cache', () => {
  it('persists across store instances and keeps only the DataDome cookie', () => {
    const saved = cookie();
    store.save('', [saved, cookie({ name: 'login', value: 'private-login' })]);
    expect(new DataDomeCookieStore(directory).load()).toEqual([saved]);
    const files = readdirSync(store.scopeDirectory(''));
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(store.scopeDirectory(''), files[0]), 'utf8')).not.toContain('private-login');
  });

  it('isolates direct traffic from different proxies without exposing credentials in filenames', () => {
    store.save('http://user:password@proxy:8080', [cookie()]);
    expect(store.load()).toEqual([]);
    expect(store.load('http://another:8080')).toEqual([]);
    expect(store.load('http://user:password@proxy:8080')).toHaveLength(1);
    expect(readdirSync(directory)[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves separate sites and cookie paths when independent browsers save', () => {
    store.save('', [cookie()]);
    store.save('', [cookie({ domain: '.casa.it' }), cookie({ path: '/search' })]);
    expect(store.load()).toHaveLength(3);
    store.save('', [cookie({ value: 'rotated' })]);
    expect(store.load()).toHaveLength(3);
    expect(store.load().find((c) => c.domain === '.immobiliare.it' && c.path === '/').value).toBe('rotated');
  });

  it('does not restore expired cookies', () => {
    store.save('', [cookie({ expires: Date.now() / 1000 - 1 })]);
    expect(store.load()).toEqual([]);
  });

  it('limits unchanged session cookies to 24 hours across repeated runs', () => {
    vi.useFakeTimers();
    const saved = cookie({ expires: -1 });
    store.save('', [saved]);
    vi.advanceTimersByTime(23 * 3600_000);
    expect(store.load()).toEqual([saved]);
    store.save('', [saved]);
    vi.advanceTimersByTime(3600_000 + 1);
    expect(store.load()).toEqual([]);
  });

  it('removes a cookie deleted by the server, without removing a concurrent replacement', () => {
    const saved = cookie();
    store.save('', [saved]);
    store.save('', [], [saved]);
    expect(store.load()).toEqual([]);
    store.save('', [cookie({ value: 'new-session' })]);
    store.save('', [], [saved]);
    expect(store.load()[0].value).toBe('new-session');
  });

  it('ignores malformed records and rejects non-DataDome records on load', () => {
    store.save('', [cookie()]);
    const scope = store.scopeDirectory('');
    writeFileSync(path.join(scope, `${'a'.repeat(64)}.json`), '{invalid');
    writeFileSync(
      path.join(scope, `${'b'.repeat(64)}.json`),
      JSON.stringify({ version: 1, expiresAt: Date.now() + 1000, cookie: cookie({ name: 'login' }) }),
    );
    expect(store.load()).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('writes private files and leaves no temporary files', () => {
    store.save('', [cookie()]);
    const scope = store.scopeDirectory('');
    expect(statSync(scope).mode & 0o777).toBe(0o700);
    const files = readdirSync(scope);
    expect(files).toHaveLength(1);
    expect(statSync(path.join(scope, files[0])).mode & 0o777).toBe(0o600);
  });
});
