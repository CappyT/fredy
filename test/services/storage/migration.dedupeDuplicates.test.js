/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../../lib/services/storage/migrations/sql/42.dedupe-price-change-duplicates.js';

/**
 * The duplicate collapse.
 *
 * The rows this migration exists for were created before the pipeline recognised an advert by its
 * link: a price change hashed differently and was stored a second time, leaving one flat carried
 * by two active rows. The migration runs plain SQL against whatever an instance has accumulated,
 * so the test backs it with a real in-memory database and asserts on what survives.
 */
let db;

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
    notes: null,
    status: null,
    manually_deleted: 0,
    is_active: 1,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO listings (id, job_id, provider, link, price, created_at, notes, status, manually_deleted, is_active)
     VALUES (@id, @job_id, @provider, @link, @price, @created_at, @notes, @status, @manually_deleted, @is_active)`,
  ).run(row);
}

const addWatch = (id, listingId) =>
  db.prepare(`INSERT INTO watch_list (id, listing_id, user_id) VALUES (?, ?, 'user-1')`).run(id, listingId);
const addHistory = (id, listingId, price) =>
  db.prepare(`INSERT INTO listing_price_history (id, listing_id, price, observed_at, source) VALUES (?, ?, ?, 1000, 'priceProbe')`).run(id, listingId, price);
const addTravelTime = (listingId, label) =>
  db.prepare(`INSERT INTO listing_travel_times (listing_id, label, transit_minutes) VALUES (?, ?, 30)`).run(listingId, label);

const ids = () => db.prepare(`SELECT id FROM listings ORDER BY id`).all().map((row) => row.id);

describe('migration 42 - collapse price-change duplicates', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id               TEXT PRIMARY KEY,
        job_id           TEXT,
        provider         TEXT,
        link             TEXT,
        price            REAL,
        created_at       INTEGER,
        notes            TEXT,
        status           TEXT,
        manually_deleted INTEGER DEFAULT 0,
        is_active        INTEGER
      );
      CREATE TABLE watch_list (
        id         TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        user_id    TEXT NOT NULL
      );
      CREATE TABLE listing_price_history (
        id          TEXT PRIMARY KEY,
        listing_id  TEXT NOT NULL,
        price       INTEGER,
        observed_at INTEGER,
        source      TEXT
      );
      CREATE TABLE listing_travel_times (
        listing_id      TEXT NOT NULL,
        label           TEXT NOT NULL,
        transit_minutes INTEGER,
        PRIMARY KEY (listing_id, label)
      );
    `);
  });

  afterEach(() => db.close());

  it('keeps the newest row of a duplicated link and removes the stale one', () => {
    addListing('stale', { link: 'https://www.immobiliare.it/annunci/1/', price: 249000, created_at: 1000 });
    addListing('fresh', { link: 'https://www.immobiliare.it/annunci/1/', price: 239000, created_at: 2000 });

    up(db);

    expect(ids()).toEqual(['fresh']);
  });

  it('carries the user data over: watches and history re-point, notes and status fill blanks', () => {
    addListing('stale', {
      link: 'https://www.immobiliare.it/annunci/1/',
      created_at: 1000,
      notes: 'call the agency',
      status: '{"liked":true}',
    });
    addListing('fresh', { link: 'https://www.immobiliare.it/annunci/1/', created_at: 2000 });
    addWatch('watch-1', 'stale');
    addHistory('hist-1', 'stale', 249000);
    addTravelTime('stale', 'home');

    up(db);

    const survivor = db.prepare(`SELECT notes, status FROM listings WHERE id = 'fresh'`).get();
    expect(survivor).toEqual({ notes: 'call the agency', status: '{"liked":true}' });
    expect(db.prepare(`SELECT listing_id FROM watch_list WHERE id = 'watch-1'`).get().listing_id).toBe('fresh');
    expect(db.prepare(`SELECT listing_id FROM listing_price_history WHERE id = 'hist-1'`).get().listing_id).toBe(
      'fresh',
    );
    // The survivor's own journeys stand; the loser's go with the loser.
    expect(db.prepare(`SELECT COUNT(*) n FROM listing_travel_times`).get().n).toBe(0);
  });

  it('leaves the data the survivor already has untouched when the loser has none to add', () => {
    addListing('stale', { link: 'https://www.immobiliare.it/annunci/1/', created_at: 1000 });
    addListing('fresh', {
      link: 'https://www.immobiliare.it/annunci/1/',
      created_at: 2000,
      notes: 'mine',
      status: '{"seen":true}',
    });

    up(db);

    const survivor = db.prepare(`SELECT notes, status FROM listings WHERE id = 'fresh'`).get();
    expect(survivor).toEqual({ notes: 'mine', status: '{"seen":true}' });
  });

  it('merges per job, so the same link under another job is not one advert', () => {
    addListing('job-one', { job_id: 'job-1', link: 'https://www.immobiliare.it/annunci/1/' });
    addListing('job-two', { job_id: 'job-2', link: 'https://www.immobiliare.it/annunci/1/' });

    up(db);

    expect(ids().sort()).toEqual(['job-one', 'job-two']);
  });

  it('leaves listings without duplicates alone', () => {
    addListing('single-1', { created_at: 1000 });
    addListing('single-2', { created_at: 2000 });

    up(db);

    expect(ids().sort()).toEqual(['single-1', 'single-2']);
  });

  it('does nothing on a database without duplicate links', () => {
    addListing('single-1');

    up(db);

    expect(ids()).toEqual(['single-1']);
  });
});
