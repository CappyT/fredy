/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../../lib/services/storage/migrations/sql/44.listing-detail-backfill.js';

/**
 * The marker that makes the detail backfill's work list finite.
 *
 * Plain SQL against a real in-memory database, the way the neighbouring migration tests are
 * written: what this one must guarantee is that the column exists, that it starts empty so no
 * existing row is treated as already asked about, that the index is shaped like the query the
 * sweep actually runs, and that running it twice is not an error - an instance that upgrades,
 * downgrades and upgrades again re-runs it.
 */
let db;

const columns = () =>
  db
    .prepare(`PRAGMA table_info(listings)`)
    .all()
    .map((column) => column.name);

describe('migration 44 - detail backfill marker', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id               TEXT PRIMARY KEY,
        job_id           TEXT,
        link             TEXT,
        created_at       INTEGER,
        is_active        INTEGER,
        manually_deleted INTEGER DEFAULT 0
      );
      INSERT INTO listings (id, job_id, link, created_at, is_active)
      VALUES ('listing-1', 'job-1', 'https://x.it/1', 1000, 1);
    `);
  });

  afterEach(() => db.close());

  it('adds the column and leaves every existing row unasked', () => {
    up(db);

    expect(columns()).toContain('detail_backfill_at');
    expect(db.prepare(`SELECT detail_backfill_at FROM listings WHERE id = ?`).get('listing-1').detail_backfill_at).toBe(
      null,
    );
  });

  it('indexes the column, because the work list filters on it every night', () => {
    up(db);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'listings'`)
      .all()
      .map((row) => row.name);
    expect(indexes).toContain('idx_listings_detail_backfill');
  });

  it('shapes the index like the query, not like the column', () => {
    up(db);

    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_listings_detail_backfill'`)
      .get().sql;
    // The marker orders the walk and `created_at` breaks its ties, which together are the sweep's
    // whole ORDER BY - that pair is what lets it stop at the batch size instead of sorting every
    // incomplete listing in the database into a temporary b-tree first.
    expect(sql).toContain('(detail_backfill_at, created_at DESC)');
    // Partial, because every row the sweep will ever look at is live, not hidden, and has a link;
    // on an instance with a retention window the rest is most of the table.
    expect(sql).toContain('WHERE is_active = 1 AND manually_deleted = 0 AND link IS NOT NULL');
  });

  it('replaces an index of the same name that was only over the marker', () => {
    db.exec(`CREATE INDEX idx_listings_detail_backfill ON listings (job_id)`);

    up(db);

    // `CREATE INDEX IF NOT EXISTS` would have kept the old shape, and nothing else ever drops it.
    expect(
      db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_listings_detail_backfill'`).get()
        .sql,
    ).toContain('detail_backfill_at');
  });

  it('is a no-op on a database that already has the column', () => {
    up(db);
    db.prepare(`UPDATE listings SET detail_backfill_at = 1000 WHERE id = ?`).run('listing-1');

    expect(() => up(db)).not.toThrow();

    expect(db.prepare(`SELECT detail_backfill_at FROM listings WHERE id = ?`).get('listing-1').detail_backfill_at).toBe(
      1000,
    );
  });
});
