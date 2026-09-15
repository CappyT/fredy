/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  COMPARABLES_IN_CURRENCY_SQL,
  COMPARABLES_SQL,
  MIN_SAMPLE,
} from '../../../lib/services/listings/marketBenchmark.js';

/**
 * The places where a franc and a euro price meet in SQL, against a real database.
 *
 * Every one of them used to treat `price` as euros: the median the market benchmark takes, the
 * dashboard's medians, the affordability band. Near a border those samples reach across it - Basel,
 * Geneva and Lugano all sit within fifteen kilometres of euro adverts - so each must keep to one
 * currency, and a row stored before currencies existed must still read as the euros it was.
 */
describe('listing currency in the listings table', () => {
  let db;
  let listingsStorage;

  const USER = 'user-1';
  /** Basel, a stone's throw from Germany and France. */
  const LAT = 47.5596;
  const LNG = 7.5886;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT,
        shared_with_user TEXT DEFAULT '[]',
        deal_type TEXT
      );
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        hash TEXT,
        provider TEXT,
        job_id TEXT,
        price REAL,
        currency TEXT,
        size REAL,
        rooms REAL,
        build_year INTEGER,
        energy_class TEXT,
        title TEXT,
        image_url TEXT,
        description TEXT,
        address TEXT,
        link TEXT,
        created_at INTEGER DEFAULT 0,
        published_at INTEGER,
        is_active INTEGER DEFAULT 1,
        inactive_since INTEGER,
        active_check_failures INTEGER DEFAULT 0,
        manually_deleted INTEGER DEFAULT 0,
        latitude REAL,
        longitude REAL,
        distances TEXT,
        status TEXT,
        price_per_sqm REAL,
        market_median_sqm REAL,
        market_sample_size INTEGER,
        market_radius_km REAL,
        last_price_check_at INTEGER,
        UNIQUE (job_id, hash)
      );
      CREATE TABLE watch_list (id TEXT PRIMARY KEY, listing_id TEXT, user_id TEXT);
      CREATE TABLE listing_attachments (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL);
      CREATE TABLE listing_travel_times (
        listing_id TEXT NOT NULL,
        label TEXT NOT NULL,
        origin_lat REAL,
        origin_lng REAL,
        transit_minutes INTEGER,
        transit_transfers INTEGER,
        car_minutes INTEGER,
        car_distance_meters INTEGER,
        car_geometry TEXT,
        bike_minutes INTEGER,
        walk_minutes INTEGER,
        is_estimate INTEGER NOT NULL DEFAULT 1,
        reference_time INTEGER,
        computed_at INTEGER,
        PRIMARY KEY (listing_id, label)
      );
    `);
    db.prepare(`INSERT INTO jobs (id, user_id, name, deal_type) VALUES ('swiss', ?, 'Basel', 'rent')`).run(USER);
    db.prepare(`INSERT INTO jobs (id, user_id, name, deal_type) VALUES ('german', ?, 'Lörrach', 'rent')`).run(USER);

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
    listingsStorage = await import('../../../lib/services/storage/listingsStorage.js');
  });

  afterEach(() => db.close());

  /**
   * @param {string} id
   * @param {Object} [options]
   * @param {string} [options.jobId]
   * @param {number|null} [options.price]
   * @param {string|null} [options.currency] `null` stands for a row from before currencies existed.
   * @param {number} [options.size]
   * @param {number} [options.km] Kilometres due north of the city centre.
   */
  const addListing = (id, { jobId = 'swiss', price = 2000, currency = 'CHF', size = 50, km = 1 } = {}) =>
    db
      .prepare(
        `INSERT INTO listings (id, hash, job_id, provider, price, currency, size, title, latitude, longitude, price_per_sqm)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        id,
        jobId,
        currency === 'CHF' ? 'flatfox' : 'immoscout',
        price,
        currency,
        size,
        id,
        LAT + km / 111.32,
        LNG,
        price == null ? null : price / size,
      );

  const rowOf = (id) => db.prepare(`SELECT * FROM listings WHERE id = ?`).get(id);

  describe('storeListings', () => {
    it('stores the currency the pipeline tagged a listing with', () => {
      const listing = {
        id: 'hash-1',
        title: 'Wohnung',
        price: 2710,
        size: 70,
        link: 'https://flatfox.ch/1',
        currency: 'CHF',
      };
      listingsStorage.storeListings('swiss', 'flatfox', [listing]);
      expect(rowOf(listing.id).currency).toBe('CHF');
    });

    it('leaves the column empty for a caller that stores no currency', () => {
      const listing = { id: 'hash-2', title: 'Wohnung', price: 900, size: 70, link: 'https://x.de/2' };
      listingsStorage.storeListings('german', 'immoscout', [listing]);
      expect(rowOf(listing.id).currency).toBeNull();
    });
  });

  describe('the market benchmark', () => {
    it('keeps the currency query identical to the original apart from the currency', () => {
      expect(COMPARABLES_IN_CURRENCY_SQL).not.toBe(COMPARABLES_SQL);
      expect(COMPARABLES_IN_CURRENCY_SQL.replace(/\n\s*AND COALESCE\(l\.currency, 'EUR'\) = @currency/, '')).toBe(
        COMPARABLES_SQL,
      );
    });

    it('measures a franc listing against franc neighbours only', () => {
      for (let index = 0; index < MIN_SAMPLE; index += 1) {
        addListing(`chf-${index}`, { price: 2000, currency: 'CHF' });
        // Euro listings a few hundred metres away at a quarter of the price per square metre.
        addListing(`eur-${index}`, { jobId: 'german', price: 500, currency: 'EUR', km: 1.2 });
      }
      addListing('target', { price: 2100, currency: 'CHF' });

      listingsStorage.applyMarketBenchmark('swiss', [{ id: 'target', latitude: LAT, longitude: LNG, currency: 'CHF' }]);

      expect(rowOf('target').market_median_sqm).toBe(40);
      expect(rowOf('target').market_sample_size).toBe(MIN_SAMPLE);
    });

    it('counts a row without a currency as euros', () => {
      for (let index = 0; index < MIN_SAMPLE; index += 1) {
        addListing(`legacy-${index}`, { jobId: 'german', price: 500, currency: null });
        addListing(`chf-${index}`, { price: 2000, currency: 'CHF', km: 1.2 });
      }
      addListing('target', { jobId: 'german', price: 600, currency: 'EUR' });

      listingsStorage.applyMarketBenchmark('german', [
        { id: 'target', latitude: LAT, longitude: LNG, currency: 'EUR' },
      ]);

      expect(rowOf('target').market_median_sqm).toBe(10);
    });

    it('gives no figure rather than a mixed one when the own currency is too thin', () => {
      for (let index = 0; index < MIN_SAMPLE; index += 1) {
        addListing(`eur-${index}`, { jobId: 'german', price: 500, currency: 'EUR' });
      }
      addListing('target', { price: 2100, currency: 'CHF' });

      listingsStorage.applyMarketBenchmark('swiss', [{ id: 'target', latitude: LAT, longitude: LNG, currency: 'CHF' }]);

      expect(rowOf('target').market_median_sqm).toBeNull();
    });

    it('measures a listing that carries no currency against everything, as before', () => {
      for (let index = 0; index < MIN_SAMPLE; index += 1) {
        addListing(`chf-${index}`, { price: 2000, currency: 'CHF' });
      }
      addListing('target', { jobId: 'german', price: 600, currency: null });

      listingsStorage.applyMarketBenchmark('german', [{ id: 'target', latitude: LAT, longitude: LNG }]);

      expect(rowOf('target').market_median_sqm).toBe(40);
    });
  });

  describe('dashboard medians', () => {
    it('are taken in the currency most priced listings are in, and say which', () => {
      [2000, 2400, 2800].forEach((price, index) => addListing(`chf-${index}`, { price, currency: 'CHF' }));
      [700, 900].forEach((price, index) => addListing(`eur-${index}`, { jobId: 'german', price, currency: 'EUR' }));

      const kpis = listingsStorage.getListingsKpisForJobIds(['swiss', 'german']);

      expect(kpis.currency).toBe('CHF');
      expect(kpis.medianPriceOfListings).toBe(2400);
      expect(kpis.medianPricePerSqm).toMatchObject({ dealType: 'rent', value: 48, sampleSize: 3 });
      // Activity is not a price and is counted across every currency.
      expect(kpis.numberOfActiveListings).toBe(5);
    });

    it('prefer euros on a tie, and count rows without a currency as euros', () => {
      addListing('chf', { price: 2000, currency: 'CHF' });
      addListing('legacy', { jobId: 'german', price: 800, currency: null });

      const kpis = listingsStorage.getListingsKpisForJobIds(['swiss', 'german']);

      expect(kpis.currency).toBe('EUR');
      expect(kpis.medianPriceOfListings).toBe(800);
    });

    it('report the default currency when nothing has a price', () => {
      addListing('unpriced', { price: null, currency: 'CHF' });
      expect(listingsStorage.getListingsKpisForJobIds(['swiss'])).toMatchObject({
        medianPriceOfListings: 0,
        currency: 'EUR',
      });
    });
  });

  describe('the affordability band', () => {
    it('never returns a listing priced in another currency', () => {
      addListing('chf-cheap', { price: 900, currency: 'CHF' });
      addListing('eur-cheap', { jobId: 'german', price: 900, currency: 'EUR' });
      addListing('legacy-cheap', { jobId: 'german', price: 950, currency: null });

      const ids = listingsStorage
        .queryListings({ userId: USER, pageSize: 100, affordabilityBand: { rent: { minExclusive: 0, max: 1120 } } })
        .result.map((row) => row.id)
        .sort();

      expect(ids).toEqual(['eur-cheap', 'legacy-cheap']);
    });

    it('does not hide franc listings when no band is asked for', () => {
      addListing('chf-cheap', { price: 900, currency: 'CHF' });
      const rows = listingsStorage.queryListings({ userId: USER, pageSize: 100 }).result;
      expect(rows.map((row) => [row.id, row.currency])).toEqual([['chf-cheap', 'CHF']]);
    });
  });

  it('hands the map its currency along with the price', () => {
    addListing('chf', { price: 2000, currency: 'CHF' });
    const { listings } = listingsStorage.getListingsForMap({ userId: USER });
    expect(listings[0]).toMatchObject({ id: 'chf', price: 2000, currency: 'CHF' });
  });

  it('carries the currency on the stored rows a price change is announced from', () => {
    db.prepare(
      `INSERT INTO listings (id, hash, job_id, provider, price, currency, link) VALUES ('p', 'p', 'swiss', 'flatfox', 2000, 'CHF', 'https://flatfox.ch/p')`,
    ).run();
    expect(listingsStorage.getKnownListingsByLinkForJob('swiss', ['https://flatfox.ch/p'])[0].currency).toBe('CHF');
    expect(listingsStorage.getListingsDueForPriceCheck({ limit: 10 })[0].currency).toBe('CHF');
  });
});
