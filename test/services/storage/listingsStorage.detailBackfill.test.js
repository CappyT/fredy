/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { up as migrate } from '../../../lib/services/storage/migrations/sql/44.listing-detail-backfill.js';

/**
 * The detail backfill's storage half.
 *
 * Plain SQL on both sides, so the mocked connection is backed by a real in-memory database rather
 * than by assertions about statement strings - which providers enter the work list, which rows it
 * must refuse to hand out, and how long an attempted row rests are exactly the kind of thing that
 * reads correctly and behaves otherwise.
 */
let db;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

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
    description: null,
    published_at: null,
    created_at: NOW - 30 * DAY,
    is_active: 1,
    manually_deleted: 0,
    detail_backfill_at: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO listings (id, job_id, provider, link, description, published_at, created_at, is_active,
                           manually_deleted, detail_backfill_at)
     VALUES (@id, @job_id, @provider, @link, @description, @published_at, @created_at, @is_active,
             @manually_deleted, @detail_backfill_at)`,
  ).run(row);
}

/** What tecnocasa declares: its detail read answers both columns. */
const BOTH = ['description', 'publishedAt'];

const workIds = (providerFields = { tecnocasa: BOTH }, options = {}) =>
  storageRef.getListingsMissingDetails(providerFields, { now: NOW, ...options }).map((row) => row.id);

let storageRef;

describe('listingsStorage detail backfill', () => {
  let storage;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE jobs (
        id      TEXT PRIMARY KEY,
        user_id TEXT
      );
      INSERT INTO jobs (id, user_id) VALUES ('job-1', 'user-1'), ('job-2', 'user-2');
      CREATE TABLE listings (
        id                 TEXT PRIMARY KEY,
        job_id             TEXT,
        provider           TEXT,
        link               TEXT,
        description        TEXT,
        created_at         INTEGER,
        published_at       INTEGER,
        is_active          INTEGER,
        manually_deleted   INTEGER DEFAULT 0,
        detail_backfill_at INTEGER
      );
    `);
    migrate(db);
    storage = await import('../../../lib/services/storage/listingsStorage.js');
    storageRef = storage;
  });

  afterEach(() => db.close());

  describe('getListingsMissingDetails', () => {
    it('hands out a row missing either column, and says which one it is missing', () => {
      addListing('textless', { published_at: NOW });
      addListing('dateless', { description: 'Trilocale luminoso.' });

      const rows = storage.getListingsMissingDetails({ tecnocasa: BOTH }, { now: NOW });

      expect(rows.map((row) => row.id).sort()).toEqual(['dateless', 'textless']);
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId.textless).toMatchObject({ needs_description: 1, needs_published_at: 0 });
      expect(byId.dateless).toMatchObject({ needs_description: 0, needs_published_at: 1 });
    });

    it('leaves out a row that already carries both', () => {
      addListing('complete', { description: 'Testo.', published_at: NOW });

      expect(workIds()).toEqual([]);
    });

    it('treats an empty description as no description', () => {
      addListing('blank', { description: '', published_at: NOW });

      expect(workIds()).toEqual(['blank']);
    });

    it('leaves out inactive rows, hidden rows, and rows without a link to read', () => {
      addListing('inactive', { is_active: 0 });
      addListing('hidden', { manually_deleted: 1 });
      addListing('unlinkable', { link: null });
      addListing('live');

      expect(workIds()).toEqual(['live']);
    });

    it('leaves out providers nobody can enrich, so no row is swept forever', () => {
      addListing('tecnocasa-1');
      addListing('subito-1', { provider: 'subito' });

      expect(workIds()).toEqual(['tecnocasa-1']);
    });

    it('offers a row only for a column its own provider is able to fill', () => {
      // idealista's detail read sets the publication date and nothing else, so a row of its that
      // lacks only a description has nowhere to get one: it used to come back every fortnight for
      // as long as it existed.
      addListing('idealista-textless', { provider: 'idealista', published_at: NOW });
      addListing('idealista-dateless', { provider: 'idealista', description: 'Piso luminoso.' });

      expect(workIds({ idealista: ['publishedAt'] })).toEqual(['idealista-dateless']);
      // The same rows are both fair game for a provider that declares both columns.
      expect(workIds({ idealista: BOTH }).sort()).toEqual(['idealista-dateless', 'idealista-textless']);
    });

    it('asks each provider only about its own rows, in one query', () => {
      addListing('tecnocasa-textless', { published_at: NOW });
      addListing('idealista-textless', { provider: 'idealista', published_at: NOW });
      addListing('idealista-dateless', { provider: 'idealista', description: 'Piso luminoso.' });

      expect(workIds({ tecnocasa: BOTH, idealista: ['publishedAt'] }).sort()).toEqual([
        'idealista-dateless',
        'tecnocasa-textless',
      ]);
    });

    it('ignores a declared field that names no stored column', () => {
      addListing('tecnocasa-1');

      // A typo must narrow the sweep, never widen it into a scan for something that does not exist.
      expect(workIds({ tecnocasa: ['descriptions'] })).toEqual([]);
      expect(workIds({ tecnocasa: ['descriptions', 'publishedAt'] })).toEqual(['tecnocasa-1']);
    });

    it('takes a batch and leaves the rest to the next run', () => {
      addListing('newest', { created_at: NOW });
      addListing('older', { created_at: NOW - 1 * DAY });
      addListing('oldest', { created_at: NOW - 2 * DAY });

      // Unbounded, this query materialised every incomplete listing in the database before the
      // first request went out - and the startup sweep, which the image sweep waits behind, ran for
      // as long as it took to walk all of it.
      expect(workIds({ tecnocasa: BOTH }, { limit: 2 })).toEqual(['newest', 'older']);
    });

    it('rests a row that was already attempted, and hands it back once the window is over', () => {
      addListing('asked-yesterday', { detail_backfill_at: NOW - 1 * DAY });
      addListing('asked-long-ago', { detail_backfill_at: NOW - 40 * DAY });

      expect(workIds()).toEqual(['asked-long-ago']);
      // The sweep can shorten the rest, which is what makes the window testable at all.
      expect(workIds({ tecnocasa: BOTH }, { retryDays: 0 }).sort()).toEqual(['asked-long-ago', 'asked-yesterday']);
    });

    it('puts the rows nobody has asked about yet first', () => {
      addListing('attempted', { detail_backfill_at: NOW - 40 * DAY, created_at: NOW });
      addListing('never-asked', { created_at: NOW - 10 * DAY });

      expect(workIds()).toEqual(['never-asked', 'attempted']);
    });

    it('carries the job owner along, because the opt-in is a per-user setting', () => {
      addListing('mine');
      addListing('theirs', { job_id: 'job-2' });

      const owners = Object.fromEntries(
        storage.getListingsMissingDetails({ tecnocasa: BOTH }, { now: NOW }).map((row) => [row.id, row.user_id]),
      );
      expect(owners).toEqual({ mine: 'user-1', theirs: 'user-2' });
    });

    it('walks the index instead of sorting the table, which is what the batch size relies on', () => {
      addListing('tecnocasa-1');
      // The same statement `getListingsMissingDetails` builds for one provider declaring one field.
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT l.id, j.user_id AS user_id
           FROM listings l
           LEFT JOIN jobs j ON j.id = l.job_id
           WHERE l.is_active = 1
             AND l.manually_deleted = 0
             AND l.link IS NOT NULL
             AND (l.detail_backfill_at IS NULL OR l.detail_backfill_at <= 0)
             AND (l.provider = 'tecnocasa' AND (l.published_at IS NULL))
           ORDER BY l.detail_backfill_at, l.created_at DESC
           LIMIT 250`,
        )
        .all()
        .map((row) => row.detail)
        .join('\n');

      expect(plan).toContain('idx_listings_detail_backfill');
      // A temporary b-tree here means every incomplete listing is materialised and sorted before
      // the sweep's first request, which is exactly what the limit was added to avoid.
      expect(plan).not.toContain('TEMP B-TREE');
    });

    it('answers nothing when no provider is named, and none when none declares a field', () => {
      addListing('tecnocasa-1');

      expect(storage.getListingsMissingDetails({})).toEqual([]);
      expect(storage.getListingsMissingDetails(undefined)).toEqual([]);
      expect(storage.getListingsMissingDetails({ tecnocasa: [] })).toEqual([]);
    });
  });

  describe('markDetailBackfillAttempt', () => {
    it('records the attempt, which is what takes the row off the list', () => {
      addListing('asked');

      storage.markDetailBackfillAttempt('asked', NOW);

      expect(db.prepare('SELECT detail_backfill_at FROM listings WHERE id = ?').get('asked').detail_backfill_at).toBe(
        NOW,
      );
      expect(workIds()).toEqual([]);
    });

    it('refuses a row it cannot name or a moment it cannot read', () => {
      addListing('asked');

      storage.markDetailBackfillAttempt(null, NOW);
      storage.markDetailBackfillAttempt('asked', Number.NaN);

      expect(
        db.prepare('SELECT detail_backfill_at FROM listings WHERE id = ?').get('asked').detail_backfill_at,
      ).toBeNull();
    });
  });

  describe('updateListingPublishedAt and updateListingDescription', () => {
    it('stores what the detail answered on the row it is told about', () => {
      addListing('tecnocasa-1');

      storage.updateListingPublishedAt('tecnocasa-1', 1757000000000);
      storage.updateListingDescription('tecnocasa-1', 'Trilocale ristrutturato.');

      const row = db.prepare('SELECT published_at, description FROM listings WHERE id = ?').get('tecnocasa-1');
      expect(row).toEqual({ published_at: 1757000000000, description: 'Trilocale ristrutturato.' });
    });

    it('refuses a value that is not an epoch, and a text that is not a text', () => {
      addListing('tecnocasa-1');

      storage.updateListingPublishedAt('tecnocasa-1', undefined);
      storage.updateListingPublishedAt('tecnocasa-1', null);
      storage.updateListingDescription('tecnocasa-1', '');

      const row = db.prepare('SELECT published_at, description FROM listings WHERE id = ?').get('tecnocasa-1');
      expect(row).toEqual({ published_at: null, description: null });
    });
  });
});
