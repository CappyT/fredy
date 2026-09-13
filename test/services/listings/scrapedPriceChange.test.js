/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { up } from '../../../lib/services/storage/migrations/sql/28.price-history.js';

/**
 * The link lane's price change, run against a real SQLite: the price change and the hash rename land
 * together or not at all.
 */
describe('services/listings/scrapedPriceChange', () => {
  const NOW = 1_800_000_000_000;
  const stored = { id: 'row-1', price: 1200, job_id: 'job-1', provider: 'immobiliare' };

  let db;
  let storage;
  let recordScrapedPriceChange;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        hash TEXT,
        job_id TEXT,
        provider TEXT,
        title TEXT,
        address TEXT,
        link TEXT,
        price INTEGER,
        created_at INTEGER,
        is_active INTEGER DEFAULT 1,
        manually_deleted INTEGER DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_listings_job_hash ON listings (job_id, hash);
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        create_date INTEGER,
        name TEXT,
        value TEXT,
        user_id TEXT
      );
      CREATE TABLE watch_list (id TEXT PRIMARY KEY, listing_id TEXT, user_id TEXT);
    `);
    up(db);
    db.prepare(
      `INSERT INTO listings (id, hash, job_id, provider, title, link, price, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('row-1', 'hash-of-1200', 'job-1', 'immobiliare', 'flat', 'https://x.it/1', 1200, NOW);

    vi.resetModules();
    vi.doMock('../../../lib/services/storage/SqliteConnection.js', () => ({
      default: {
        getConnection: () => db,
        query: (sql, params) => db.prepare(sql).all(params),
        execute: (sql, params) => db.prepare(sql).run(params),
        withTransaction: (callback) => db.transaction(() => callback(db))(),
      },
    }));
    vi.doMock('../../../lib/services/similarity-check/similarityCache.js', () => ({ removeEntry: vi.fn() }));
    vi.doMock('../../../lib/notification/notify.js', () => ({ sendPriceChange: vi.fn() }));
    storage = await import('../../../lib/services/storage/listingsStorage.js');
    ({ recordScrapedPriceChange } = await import('../../../lib/services/listings/scrapedPriceChange.js'));
  });

  afterEach(() => db.close());

  const row = () =>
    db.prepare('SELECT price, previous_price, price_changed_at, hash FROM listings WHERE id = ?').get('row-1');

  it('moves the price and the hash together and records the reading', () => {
    const change = recordScrapedPriceChange(stored, 1100, 'hash-of-1100', {
      source: 'scrape',
      now: NOW,
      thresholdPercent: 1,
    });

    expect(change).toMatchObject({ oldPrice: 1200, newPrice: 1100, direction: 'down' });
    expect(row()).toEqual({ price: 1100, previous_price: 1200, price_changed_at: NOW, hash: 'hash-of-1100' });
    expect(storage.getPriceHistory('row-1')).toEqual([{ price: 1100, observed_at: NOW, source: 'scrape' }]);
  });

  it('moves only the hash when the price has not changed', () => {
    // The price probe moves a price without the hash; the scrape brings the hash back in line.
    const change = recordScrapedPriceChange(stored, 1200, 'hash-of-1200-again', { source: 'scrape', now: NOW });

    expect(change).toBeNull();
    expect(row()).toEqual({ price: 1200, previous_price: null, price_changed_at: null, hash: 'hash-of-1200-again' });
    expect(storage.getPriceHistory('row-1')).toEqual([]);
  });

  it('moves nothing for a price it could not read', () => {
    expect(recordScrapedPriceChange(stored, null, 'hash-of-nothing', { source: 'scrape', now: NOW })).toBeNull();

    expect(row()).toEqual({ price: 1200, previous_price: null, price_changed_at: null, hash: 'hash-of-1200' });
  });

  it('keeps the old hash when a sibling row of the same job already holds the new one', () => {
    db.prepare(`INSERT INTO listings (id, hash, job_id, price, is_active) VALUES (?,?,?,?,?)`).run(
      'corpse',
      'hash-of-1100',
      'job-1',
      1100,
      0,
    );

    expect(() => recordScrapedPriceChange(stored, 1100, 'hash-of-1100', { source: 'scrape', now: NOW })).not.toThrow();

    expect(row()).toEqual({ price: 1100, previous_price: 1200, price_changed_at: NOW, hash: 'hash-of-1200' });
  });

  it('rolls the price change back when the rename fails', () => {
    // Only the rename changes the hash, so this aborts the second write of the transaction.
    db.exec(`CREATE TRIGGER fail_rename BEFORE UPDATE OF hash ON listings WHEN NEW.hash IS NOT OLD.hash
             BEGIN SELECT RAISE(ABORT, 'rename failed'); END`);

    expect(() => recordScrapedPriceChange(stored, 1100, 'hash-of-1100', { source: 'scrape', now: NOW })).toThrow(
      'rename failed',
    );

    expect(row()).toEqual({ price: 1200, previous_price: null, price_changed_at: null, hash: 'hash-of-1200' });
    expect(storage.getPriceHistory('row-1')).toEqual([]);
  });
});
