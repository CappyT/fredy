/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The two lanes of the novelty check, side by side.
 *
 * A listing's hash is built over the advert id and its price, so a price change reads as new and
 * the identity that survives the change is the link. Which stored rows each lane still recognises
 * has to be the same answer, and they are tested together because a row one lane remembers while
 * the other has forgotten it falls between them: it is neither rediscovered nor recognised. Plain
 * SQL on both sides, so the mocked connection is backed by a real in-memory database rather than
 * by assertions about statement strings.
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
    hash: `hash-${id}`,
    job_id: 'job-1',
    provider: 'immobiliare',
    link: `https://www.immobiliare.it/annunci/${id}/`,
    price: 200000,
    created_at: 1000,
    is_active: 1,
    manually_deleted: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO listings (id, hash, job_id, provider, link, price, created_at, is_active, manually_deleted)
     VALUES (@id, @hash, @job_id, @provider, @link, @price, @created_at, @is_active, @manually_deleted)`,
  ).run(row);
}

describe('listingsStorage.getKnownListingsByLinkForJob', () => {
  let storage;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id               TEXT PRIMARY KEY,
        hash             TEXT,
        job_id           TEXT,
        provider         TEXT,
        link             TEXT,
        price            REAL,
        created_at       INTEGER,
        is_active        INTEGER,
        manually_deleted INTEGER DEFAULT 0
      );
    `);
    storage = await import('../../../lib/services/storage/listingsStorage.js');
  });

  afterEach(() => db.close());

  it('recognises an advert the job already stores under another hash', () => {
    addListing('stored-1');

    const rows = storage.getKnownListingsByLinkForJob('job-1', ['https://www.immobiliare.it/annunci/stored-1/']);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'stored-1', job_id: 'job-1', price: 200000 });
  });

  it('answers the newest row for a link several rows have carried', () => {
    addListing('older', { link: 'https://www.immobiliare.it/annunci/shared/', created_at: 1000 });
    addListing('newer', { link: 'https://www.immobiliare.it/annunci/shared/', created_at: 2000 });

    const rows = storage.getKnownListingsByLinkForJob('job-1', ['https://www.immobiliare.it/annunci/shared/']);

    expect(rows.map((row) => row.id)).toEqual(['newer']);
  });

  it('keeps the jobs apart, so the same advert under another job stays new there', () => {
    addListing('job-one-row', { job_id: 'job-1' });

    expect(storage.getKnownListingsByLinkForJob('job-2', ['https://www.immobiliare.it/annunci/job-one-row/'])).toEqual(
      [],
    );
  });

  it('leaves out listings the user hid, so a hidden flat is never moved by a scrape', () => {
    addListing('hidden', { manually_deleted: 1 });

    expect(storage.getKnownListingsByLinkForJob('job-1', ['https://www.immobiliare.it/annunci/hidden/'])).toEqual([]);
  });

  it('leaves out rows the alive-checker declared gone, so a repost is stored as a listing again', () => {
    addListing('inactive', { is_active: 0 });

    // Nothing turns is_active back on by itself, so absorbing the repost into the dead row would
    // have announced a price drop on a listing the view does not show and never store it again.
    expect(storage.getKnownListingsByLinkForJob('job-1', ['https://www.immobiliare.it/annunci/inactive/'])).toEqual([]);
  });

  it('keeps a row whose is_active was never written - the column predates the checker', () => {
    addListing('unknown-state', { is_active: null });

    expect(
      storage.getKnownListingsByLinkForJob('job-1', ['https://www.immobiliare.it/annunci/unknown-state/']),
    ).toHaveLength(1);
  });

  it('answers the newest *active* row when a dead one is newer', () => {
    addListing('alive', { link: 'https://www.immobiliare.it/annunci/shared/', created_at: 1000, is_active: 1 });
    addListing('gone', { link: 'https://www.immobiliare.it/annunci/shared/', created_at: 2000, is_active: 0 });

    const rows = storage.getKnownListingsByLinkForJob('job-1', ['https://www.immobiliare.it/annunci/shared/']);

    expect(rows.map((row) => row.id)).toEqual(['alive']);
  });

  it('answers nothing without a job, links, or usable link values', () => {
    addListing('stored-1');

    expect(storage.getKnownListingsByLinkForJob(null, ['https://x/'])).toEqual([]);
    expect(storage.getKnownListingsByLinkForJob('job-1', [])).toEqual([]);
    expect(storage.getKnownListingsByLinkForJob('job-1', [null, '', '  '])).toEqual([]);
  });

  describe('the hash lane it has to agree with', () => {
    it('forgets a row the alive-checker declared gone, so a repost reaches the link lane', () => {
      addListing('gone', { is_active: 0 });

      // While this lane still remembered dead rows, a repost at the unchanged price hashed exactly
      // like the corpse and was filtered out here - never stored, never brought back, and gone from
      // the job for good.
      expect(storage.getKnownListingHashesForJob('job-1')).toEqual([]);
    });

    it('remembers a row the user hid, however dead it is', () => {
      addListing('hidden', { manually_deleted: 1 });
      addListing('hidden-and-gone', { manually_deleted: 1, is_active: 0 });

      // Hiding an advert says "I am done with this one", and the similarity and area filters leave
      // their tombstones the same way: forgetting these would re-find and re-notify every one of
      // them on the next run, and collide with the hidden row on insert.
      expect(storage.getKnownListingHashesForJob('job-1').sort()).toEqual(['hash-hidden', 'hash-hidden-and-gone']);
    });

    it('remembers the live rows, including one whose is_active was never written', () => {
      addListing('live');
      addListing('legacy', { is_active: null });

      expect(storage.getKnownListingHashesForJob('job-1').sort()).toEqual(['hash-legacy', 'hash-live']);
    });

    it('keeps the jobs apart', () => {
      addListing('theirs', { job_id: 'job-2' });

      expect(storage.getKnownListingHashesForJob('job-1')).toEqual([]);
    });
  });
});
