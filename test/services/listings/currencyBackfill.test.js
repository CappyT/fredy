/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { MIN_SAMPLE } from '../../../lib/services/listings/marketBenchmark.js';

/**
 * Labelling the listings stored before the currency column existed.
 *
 * Migration 900 can only add the column, because the countries live in the provider modules. This
 * pass fills it once they are loaded, and gives the franc listings among them a market median taken
 * over francs, since the one they carry was taken over whatever lay within fifteen kilometres.
 */
describe('backfillListingCurrency', () => {
  let db;
  let backfillListingCurrency;
  let warn;

  const LAT = 47.5596;
  const LNG = 7.5886;

  const FLATFOX = { metaInformation: { id: 'flatfox', countries: ['ch'] } };
  const IMMOSCOUT = { metaInformation: { id: 'immoscout', countries: ['de'] } };
  const ALPINE = {
    metaInformation: {
      id: 'alpine',
      countries: ['ch', 'de'],
      countryOf: (listing) => (String(listing.link).includes('.ch/') ? 'ch' : 'de'),
    },
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY, deal_type TEXT);
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        provider TEXT,
        link TEXT,
        title TEXT,
        description TEXT,
        price REAL,
        size REAL,
        currency TEXT,
        latitude REAL,
        longitude REAL,
        manually_deleted INTEGER DEFAULT 0,
        price_per_sqm REAL,
        market_median_sqm REAL,
        market_sample_size INTEGER,
        market_radius_km REAL,
        scam_signals TEXT
      );
    `);
    db.prepare(`INSERT INTO jobs (id, deal_type) VALUES ('swiss', 'rent'), ('german', 'rent')`).run();

    warn = vi.fn();
    vi.resetModules();
    vi.doMock('../../../lib/services/storage/SqliteConnection.js', () => ({
      default: {
        getConnection: () => db,
        query: (sql, params) => db.prepare(sql).all(params ?? {}),
        execute: (sql, params) => db.prepare(sql).run(params ?? {}),
        withTransaction: (callback) => db.transaction(() => callback(db))(),
      },
    }));
    vi.doMock('../../../lib/services/similarity-check/similarityCache.js', () => ({ removeEntry: vi.fn() }));
    vi.doMock('../../../lib/services/logger.js', () => ({
      default: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() },
    }));
    ({ backfillListingCurrency } = await import('../../../lib/services/listings/currencyBackfill.js'));
  });

  afterEach(() => db.close());

  const add = (
    id,
    { provider = 'flatfox', jobId = 'swiss', price = 2000, size = 50, currency = null, link, median } = {},
  ) =>
    db
      .prepare(
        `INSERT INTO listings (id, job_id, provider, link, title, price, size, currency, latitude, longitude,
                               price_per_sqm, market_median_sqm, market_sample_size, market_radius_km)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        jobId,
        provider,
        link ?? `https://${provider}.example/${id}`,
        id,
        price,
        size,
        currency,
        LAT,
        LNG,
        price / size,
        median ?? null,
        median == null ? null : 20,
        median == null ? null : 5,
      );

  const currencyOf = (id) => db.prepare(`SELECT currency FROM listings WHERE id = ?`).get(id).currency;

  it('labels every unlabelled listing with the currency of its provider', () => {
    add('swiss-1');
    add('german-1', { provider: 'immoscout', jobId: 'german', price: 800 });

    const result = backfillListingCurrency([FLATFOX, IMMOSCOUT]);

    expect(currencyOf('swiss-1')).toBe('CHF');
    expect(currencyOf('german-1')).toBe('EUR');
    expect(result).toEqual({ filled: 2, relabelled: 1 });
  });

  it('follows a provider that narrows each listing to one country', () => {
    add('alpine-ch', { provider: 'alpine', link: 'https://alpine.ch/1' });
    add('alpine-de', { provider: 'alpine', jobId: 'german', link: 'https://alpine.de/1' });

    backfillListingCurrency([ALPINE]);

    expect(currencyOf('alpine-ch')).toBe('CHF');
    expect(currencyOf('alpine-de')).toBe('EUR');
  });

  it('leaves labelled rows, and rows of providers no longer loaded, alone', () => {
    add('already', { currency: 'EUR' });
    add('orphan', { provider: 'gone' });

    expect(backfillListingCurrency([FLATFOX])).toEqual({ filled: 0, relabelled: 0 });
    expect(currencyOf('already')).toBe('EUR');
    expect(currencyOf('orphan')).toBeNull();
  });

  it('is done after one pass', () => {
    add('swiss-1');
    backfillListingCurrency([FLATFOX]);
    expect(backfillListingCurrency([FLATFOX])).toEqual({ filled: 0, relabelled: 0 });
  });

  it('measures a franc listing again against francs only', () => {
    for (let index = 0; index < MIN_SAMPLE; index += 1) {
      add(`chf-${index}`, { currency: 'CHF', price: 2000 });
      add(`eur-${index}`, { provider: 'immoscout', jobId: 'german', currency: 'EUR', price: 500 });
    }
    // Stored before currencies existed, and benchmarked against the euro neighbours as well.
    add('target', { price: 2100, median: 25 });

    backfillListingCurrency([FLATFOX]);

    const row = db.prepare(`SELECT * FROM listings WHERE id = 'target'`).get();
    expect(row.currency).toBe('CHF');
    expect(row.market_median_sqm).toBe(40);
    expect(row.market_sample_size).toBe(MIN_SAMPLE);
  });

  it('drops a mixed median it cannot replace with one in the listing currency', () => {
    for (let index = 0; index < MIN_SAMPLE; index += 1) {
      add(`eur-${index}`, { provider: 'immoscout', jobId: 'german', currency: 'EUR', price: 500 });
    }
    add('target', { price: 2100, median: 10 });

    backfillListingCurrency([FLATFOX]);

    const row = db.prepare(`SELECT * FROM listings WHERE id = 'target'`).get();
    expect(row.market_median_sqm).toBeNull();
    expect(row.market_sample_size).toBeNull();
    expect(row.market_radius_km).toBeNull();
  });

  it('does not touch the median of a listing that stays in euros', () => {
    add('german-1', { provider: 'immoscout', jobId: 'german', price: 800, median: 14 });
    backfillListingCurrency([IMMOSCOUT]);
    expect(db.prepare(`SELECT market_median_sqm FROM listings WHERE id = 'german-1'`).get().market_median_sqm).toBe(14);
  });

  it('never throws, so a broken table cannot stop Fredy from starting', () => {
    db.exec(`DROP TABLE listings`);
    expect(backfillListingCurrency([FLATFOX])).toEqual({ filled: 0, relabelled: 0 });
    expect(warn).toHaveBeenCalled();
  });
});
