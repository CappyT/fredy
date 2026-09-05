/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The link-identity query.
 *
 * A listing's hash is built over the advert id and its price, so a price change reads as new and
 * the identity that survives the change is the link. Plain SQL on both sides, so the mocked
 * connection is backed by a real in-memory database rather than by assertions about statement
 * strings.
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
    provider: 'immobiliare',
    link: `https://www.immobiliare.it/annunci/${id}/`,
    price: 200000,
    created_at: 1000,
    is_active: 1,
    manually_deleted: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO listings (id, job_id, provider, link, price, created_at, is_active, manually_deleted)
     VALUES (@id, @job_id, @provider, @link, @price, @created_at, @is_active, @manually_deleted)`,
  ).run(row);
}

describe('listingsStorage.getKnownListingsByLinkForJob', () => {
  let storage;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id               TEXT PRIMARY KEY,
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

  it('keeps inactive rows in the answer - the alive-checker owns bringing them back', () => {
    addListing('inactive', { is_active: 0 });

    expect(storage.getKnownListingsByLinkForJob('job-1', ['https://www.immobiliare.it/annunci/inactive/'])).toHaveLength(
      1,
    );
  });

  it('answers nothing without a job, links, or usable link values', () => {
    addListing('stored-1');

    expect(storage.getKnownListingsByLinkForJob(null, ['https://x/'])).toEqual([]);
    expect(storage.getKnownListingsByLinkForJob('job-1', [])).toEqual([]);
    expect(storage.getKnownListingsByLinkForJob('job-1', [null, '', '  '])).toEqual([]);
  });
});
