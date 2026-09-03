/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { storeListings, queryListings } from '../../../lib/services/storage/listingsStorage.js';

/**
 * The date the portal itself states, and the order the list reads in.
 *
 * The whole point of published_at is the difference between two moments that created_at cannot
 * tell apart: a flat published two weeks ago and only discovered today is the older of the two,
 * and an advert re-published to the top of a search is the newer one again. So the mocked
 * connection is backed by a real in-memory database - an ORDER BY over a nullable column is
 * exactly the kind of thing that reads correctly and behaves otherwise.
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
  isListingKnownAndAddIfNot: () => false,
  initSimilarityCache: () => {},
  startSimilarityCacheReloader: () => {},
  checkAndAddEntry: () => false,
}));

const DAY = 24 * 60 * 60 * 1000;

describe('the date the portal states, and the order it is read in', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id            TEXT PRIMARY KEY,
        hash          TEXT,
        provider      TEXT,
        job_id        TEXT,
        title         TEXT,
        address       TEXT,
        price         REAL,
        size          REAL,
        rooms         REAL,
        build_year    INTEGER,
        energy_class  TEXT,
        image_url     TEXT,
        description   TEXT,
        link          TEXT,
        created_at    INTEGER,
        published_at  INTEGER,
        is_active     INTEGER,
        latitude      REAL,
        longitude     REAL,
        manually_deleted INTEGER DEFAULT 0,
        status        JSON
      );
      CREATE UNIQUE INDEX listings_job_hash ON listings (job_id, hash);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT, deal_type TEXT, user_id TEXT, shared_with_user TEXT);
      CREATE TABLE watch_list (id TEXT PRIMARY KEY, listing_id TEXT, user_id TEXT);
      CREATE TABLE listing_travel_times (
        listing_id TEXT, label TEXT, transit_minutes INTEGER, car_minutes INTEGER,
        bike_minutes INTEGER, walk_minutes INTEGER, is_estimate INTEGER, transit_geometry TEXT,
        origin_lat REAL, origin_lng REAL, computed_at INTEGER
      );
      INSERT INTO jobs (id, name, user_id, shared_with_user) VALUES ('job-1', 'Cerca', 'user-1', '[]');
    `);
  });

  /**
   * The one shape the pipeline hands the store: the store fills in everything else itself.
   *
   * @param {string} hash
   * @param {number|null} publishedAt
   * @returns {Object}
   */
  const listing = (hash, publishedAt) => ({
    id: hash,
    title: `listing ${hash}`,
    price: 100000,
    size: 80,
    rooms: 3,
    address: 'Via Roma 1, Roma',
    link: 'https://www.example.it/annunci/1/',
    publishedAt,
  });

  it('orders by the date the portal states before the date Fredy found the listing', () => {
    // Found a day ago, no date the portal would state: it keeps the moment it was found.
    storeListings('job-1', 'idealista', [listing('hash-undated', null)]);
    db.prepare(`UPDATE listings SET created_at = ? WHERE hash = 'hash-undated'`).run(Date.now() - DAY);
    // Found just now, published two weeks ago: the older of the two, whatever created_at says.
    storeListings('job-1', 'casa', [listing('hash-old-advert', Date.now() - 14 * DAY)]);

    const rows = queryListings({ jobIdFilter: 'job-1', isAdmin: true }).result;

    expect(rows).toHaveLength(2);
    // The undated listing is the newer of the two: yesterday beats two weeks ago.
    expect(rows[0].hash).toBe('hash-undated');
    expect(rows[1].hash).toBe('hash-old-advert');
  });

  it('updates the date when the portal says the advert was edited again', () => {
    const first = listing('hash-bumped', Date.now() - 10 * DAY);
    storeListings('job-1', 'casa', [first]);

    const again = listing('hash-bumped', Date.now());
    storeListings('job-1', 'casa', [again]);

    const rows = queryListings({ jobIdFilter: 'job-1', isAdmin: true }).result;
    expect(rows).toHaveLength(1);
    expect(rows[0].published_at).toBe(again.publishedAt);
    // The upsert still hands back the row that was already there, which is what the later
    // pipeline steps key on.
    expect(again.id).toBe(first.id);
  });

  it('keeps the stored date when the portal states none the second time around', () => {
    const first = listing('hash-once-dated', Date.now() - DAY);
    storeListings('job-1', 'casa', [first]);

    storeListings('job-1', 'casa', [listing('hash-once-dated', null)]);

    const rows = queryListings({ jobIdFilter: 'job-1', isAdmin: true }).result;
    expect(rows[0].published_at).toBe(first.publishedAt);
  });
});
