/*
 * Copyright (c) 2026 by Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The storage half of the photograph keeping.
 *
 * Plain SQL on both sides, so the mocked connection is backed by a real in-memory database: what
 * the work list must and must not hand out, and what the guards refuse to store, are exactly the
 * kind of thing that reads correctly and behaves otherwise.
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
    provider: 'idealista',
    link: `https://www.idealista.it/it/ad/${id}/`,
    image_url: 'https://img.idealista.it/signed',
    is_active: 1,
    manually_deleted: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO listings (id, job_id, provider, link, image_url, is_active, manually_deleted)
     VALUES (@id, @job_id, @provider, @link, @image_url, @is_active, @manually_deleted)`,
  ).run(row);
}

describe('listingsStorage stored images', () => {
  let storage;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id               TEXT PRIMARY KEY,
        job_id           TEXT,
        provider         TEXT,
        link             TEXT,
        image_url        TEXT,
        created_at       INTEGER,
        is_active        INTEGER,
        manually_deleted INTEGER DEFAULT 0
      );
      CREATE TABLE listing_images (
        listing_id TEXT PRIMARY KEY,
        mime_type  TEXT NOT NULL,
        bytes      BLOB NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
    storage = await import('../../../lib/services/storage/listingsStorage.js');
  });

  afterEach(() => db.close());

  describe('getListingsMissingStoredImage', () => {
    it('hands out rows that carry a portal url but no stored bytes', () => {
      addListing('photoless-1');

      expect(storage.getListingsMissingStoredImage(['idealista']).map((row) => row.id)).toEqual(['photoless-1']);
    });

    it('leaves out rows whose bytes are already kept', () => {
      addListing('kept');
      storage.storeListingImage('kept', 'image/webp', Buffer.from('x'));

      expect(storage.getListingsMissingStoredImage(['idealista'])).toEqual([]);
    });

    it('leaves out listings the portal showed no image for', () => {
      addListing('no-photo', { image_url: null });

      expect(storage.getListingsMissingStoredImage(['idealista'])).toEqual([]);
    });

    it('keeps other providers out of the list, so nobody sweeps what it cannot fetch', () => {
      addListing('subito-row', { provider: 'subito' });

      expect(storage.getListingsMissingStoredImage(['idealista'])).toEqual([]);
    });

    it('honours the batch size', () => {
      addListing('a');
      addListing('b');
      addListing('c');

      expect(storage.getListingsMissingStoredImage(['idealista'], 2)).toHaveLength(2);
    });
  });

  describe('storeListingImage / getListingImage', () => {
    it('round-trips the bytes and the content type', () => {
      storage.storeListingImage('row-1', 'image/webp', Buffer.from('photograph'));

      expect(storage.getListingImage('row-1').mime_type).toBe('image/webp');
      expect(storage.getListingImage('row-1').bytes.toString()).toBe('photograph');
    });

    it('replaces the photograph when the portal shows a newer one', () => {
      storage.storeListingImage('row-1', 'image/webp', Buffer.from('old'));
      storage.storeListingImage('row-1', 'image/jpeg', Buffer.from('new'));

      expect(storage.getListingImage('row-1').bytes.toString()).toBe('new');
    });

    it('refuses to keep nothing', () => {
      storage.storeListingImage('row-1', 'image/webp', Buffer.alloc(0));
      storage.storeListingImage('row-1', '', Buffer.from('x'));
      storage.storeListingImage(null, 'image/webp', Buffer.from('x'));

      expect(storage.getListingImage('row-1')).toBeNull();
    });
  });
});
