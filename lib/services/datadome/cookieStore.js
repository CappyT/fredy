/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Keep only DataDome cookie attributes understood by the browser cookie API.
 *
 * @param {import('puppeteer-core').Cookie} cookie
 * @returns {import('puppeteer-core').CookieData|null}
 */
function normalize(cookie) {
  if (
    cookie?.name !== 'datadome' ||
    typeof cookie.value !== 'string' ||
    !cookie.value ||
    typeof cookie.domain !== 'string' ||
    !cookie.domain ||
    typeof cookie.path !== 'string' ||
    !Number.isFinite(cookie.expires)
  )
    return null;
  const result = {};
  for (const key of [
    'name',
    'value',
    'domain',
    'path',
    'expires',
    'httpOnly',
    'secure',
    'sameSite',
    'priority',
    'sourceScheme',
    'partitionKey',
  ]) {
    if (cookie[key] !== undefined) result[key] = cookie[key];
  }
  return result;
}

const cookieKey = (cookie) => hash(JSON.stringify([cookie.domain, cookie.path, cookie.partitionKey ?? null]));

/**
 * A disk cache containing only DataDome cookies, isolated by proxy configuration.
 * Each cookie has its own atomically replaced file: saving one site's cookies
 * does not discard another site's cookies from a concurrent browser run.
 */
export class DataDomeCookieStore {
  /** @param {string} directory Persistent cache directory (normally under conf). */
  constructor(directory) {
    this.directory = directory;
  }

  /**
   * @param {string} proxy Proxy URL, or an empty string for a direct connection.
   * @returns {string} Cache directory without plaintext proxy credentials in its name.
   */
  scopeDirectory(proxy) {
    return path.join(this.directory, hash(proxy?.trim() || 'direct'));
  }

  /**
   * Read unexpired cookies. Malformed records are ignored individually.
   *
   * @param {string} [proxy]
   * @returns {import('puppeteer-core').CookieData[]}
   */
  load(proxy = '') {
    const directory = this.scopeDirectory(proxy);
    let files;
    try {
      files = readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const cookies = [];
    for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      try {
        const record = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
        const cookie = normalize(record.cookie);
        if (
          record.version === 1 &&
          cookie &&
          Number.isFinite(record.expiresAt) &&
          record.expiresAt > Date.now() &&
          (cookie.expires === -1 || cookie.expires * 1000 > Date.now())
        )
          cookies.push(cookie);
      } catch {
        // A truncated or outdated cache record must not prevent a browser run.
      }
    }
    return cookies;
  }

  /**
   * Save the current DataDome cookies, never login or other application cookies.
   * Session cookies receive a 24-hour cache lifetime. An unchanged session cookie
   * keeps its original cache expiry rather than extending it on every run.
   *
   * @param {string} proxy
   * @param {import('puppeteer-core').Cookie[]} cookies
   * @param {import('puppeteer-core').CookieData[]} [restored] Previously restored cookies, to detect deletion.
   * @returns {void}
   */
  save(proxy, cookies, restored = []) {
    const directory = this.scopeDirectory(proxy);
    const current = cookies.map(normalize).filter(Boolean);
    if (!current.length && !restored.length) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const cookie of current) {
      const file = path.join(directory, `${cookieKey(cookie)}.json`);
      let expiresAt = cookie.expires === -1 ? Date.now() + SESSION_LIFETIME_MS : cookie.expires * 1000;
      if (cookie.expires === -1) {
        try {
          const previous = JSON.parse(readFileSync(file, 'utf8'));
          if (previous.cookie.value === cookie.value && Number.isFinite(previous.expiresAt))
            expiresAt = previous.expiresAt;
        } catch {
          /* No prior valid record. */
        }
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, expiresAt, cookie }), { mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // Cleanup must not replace an original write or rename error.
        }
      }
    }
    const currentKeys = new Set(current.map(cookieKey));
    for (const cookie of restored) {
      if (currentKeys.has(cookieKey(cookie))) continue;
      const file = path.join(directory, `${cookieKey(cookie)}.json`);
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'));
        // Do not remove a replacement that another browser has already saved.
        if (record.cookie.value === cookie.value) unlinkSync(file);
      } catch {
        /* Already removed or unreadable. */
      }
    }
  }
}
