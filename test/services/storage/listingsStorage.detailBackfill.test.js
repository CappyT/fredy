/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The publication-date backfill's storage half.
 *
 * Plain SQL on both sides, so the mocked connection is backed by a real in-memory database rather
 * than by assertions about statement strings - which providers enter the work list, and which rows
 * it must refuse to hand out, are exactly the kind of thing that reads correctly and behaves
 * otherwise.
 */
let db;

vi.mock('../../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    execute: (sql, params = {}) => db.prepare(sql).run(params),
    query: (sql, params = {}) => db.prepare(sql).all(params),
    withTransaction: (callback) => db.transaction((cb) => cb(db))(callback),
  },
}));
vi.mock('../../../lib/services/similarity-check/similarityCache.js', () => ({
  removeEntry: () => {},
}));

/**
 * @param {string} id
 * @param {Object} [overrides]
 * @returns {void}
 */
function addListing(id, overrides = {}) {
  const row = {
    id,
    job_id: 'job-1',
    provider: 'tecnocasa',
    link: `https://www.tecnocasa.it/advert/${id}.html`,
    published_at: null,
    is_active: 1,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO listings (id, job_id, provider, link, published_at, is_active)
     VALUES (@id, @job_id, @provider, @link, @published_at, @is_active)`,
  ).run(row);
}

describe('listingsStorage published_at backfill', () => {
  let storage;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id           TEXT PRIMARY KEY,
        job_id       TEXT,
        provider     TEXT,
        link         TEXT,
        created_at   INTEGER,
        published_at INTEGER,
        is_active    INTEGER
      );
    `);
    storage = await import('../../../lib/services/storage/listingsStorage.js');
  });

  afterEach(() => db.close());

  describe('getListingsMissingPublishedAt', () => {
    it('hands out the dateless rows of the providers it is asked about', () => {
      addListing('tecnocasa-1');
      addListing('idealista-1', { provider: 'idealista', link: 'https://www.idealista.it/it/ad/1/' });

      const rows = storage.getListingsMissingPublishedAt(['tecnocasa', 'idealista']);

      expect(rows.map((row) => row.id).sort()).toEqual(['idealista-1', 'tecnocasa-1']);
    });

    it('leaves out rows that already carry a date', () => {
      addListing('dated', { published_at: 1757000000000 });
      addListing('dateless');

      expect(storage.getListingsMissingPublishedAt(['tecnocasa']).map((row) => row.id)).toEqual(['dateless']);
    });

    it('leaves out inactive rows and rows without a link to read', () => {
      addListing('inactive', { is_active: 0 });
      addListing('unlinkable', { link: null });
      addListing('live');

      expect(storage.getListingsMissingPublishedAt(['tecnocasa']).map((row) => row.id)).toEqual(['live']);
    });

    it('leaves out providers nobody can enrich, so no row is swept forever', () => {
      addListing('tecnocasa-1');
      addListing('subito-1', { provider: 'subito' });

      expect(storage.getListingsMissingPublishedAt(['tecnocasa']).map((row) => row.id)).toEqual(['tecnocasa-1']);
    });

    it('answers nothing when no provider is named', () => {
      addListing('tecnocasa-1');

      expect(storage.getListingsMissingPublishedAt([])).toEqual([]);
      expect(storage.getListingsMissingPublishedAt(undefined)).toEqual([]);
    });
  });

  describe('updateListingPublishedAt', () => {
    it('stores the date on the row it is told about', () => {
      addListing('tecnocasa-1');

      storage.updateListingPublishedAt('tecnocasa-1', 1757000000000);

      expect(db.prepare('SELECT published_at FROM listings WHERE id = ?').get('tecnocasa-1').published_at).toBe(
        1757000000000,
      );
    });

    it('refuses a value that is not an epoch', () => {
      addListing('tecnocasa-1');

      storage.updateListingPublishedAt('tecnocasa-1', undefined);
      storage.updateListingPublishedAt('tecnocasa-1', null);

      expect(db.prepare('SELECT published_at FROM listings WHERE id = ?').get('tecnocasa-1').published_at).toBeNull();
    });
  });
});
