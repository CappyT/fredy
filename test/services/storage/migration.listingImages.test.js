/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../../lib/services/storage/migrations/sql/43.listing-images.js';

/**
 * The table the photographs live in.
 *
 * Plain SQL against a real in-memory database: what the migration must guarantee is that the
 * bytes die with their listing - the cascade - and that the table can hold the same photograph
 * twice under two listings without tripping over its primary key.
 */
let db;

describe('migration 43 - listing images', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        job_id TEXT
      );
      INSERT INTO listings (id, job_id) VALUES ('listing-1', 'job-1'), ('listing-2', 'job-1');
    `);
  });

  afterEach(() => db.close());

  it('creates the table and keeps the bytes keyed by listing', () => {
    up(db);

    db.prepare(`INSERT INTO listing_images (listing_id, mime_type, bytes, fetched_at) VALUES (?, ?, ?, ?)`).run(
      'listing-1',
      'image/webp',
      Buffer.from('bytes-of-the-photo'),
      1000,
    );

    const row = db.prepare(`SELECT mime_type, bytes FROM listing_images WHERE listing_id = ?`).get('listing-1');
    expect(row.mime_type).toBe('image/webp');
    expect(row.bytes.toString()).toBe('bytes-of-the-photo');
  });

  it('takes the bytes with the listing when the listing goes', () => {
    up(db);
    db.prepare(`INSERT INTO listing_images (listing_id, mime_type, bytes, fetched_at) VALUES (?, ?, ?, ?)`).run(
      'listing-1',
      'image/webp',
      Buffer.from('x'),
      1000,
    );
    db.pragma('foreign_keys = ON');

    db.prepare(`DELETE FROM listings WHERE id = ?`).run('listing-1');

    expect(db.prepare(`SELECT COUNT(*) n FROM listing_images`).get().n).toBe(0);
  });

  it('holds one photograph per listing, the later read replacing the earlier', () => {
    up(db);
    const insert = db.prepare(`
      INSERT INTO listing_images (listing_id, mime_type, bytes, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(listing_id) DO UPDATE SET mime_type = excluded.mime_type, bytes = excluded.bytes
    `);

    insert.run('listing-1', 'image/webp', Buffer.from('old'), 1000);
    insert.run('listing-1', 'image/jpeg', Buffer.from('new'), 2000);

    expect(db.prepare(`SELECT COUNT(*) n FROM listing_images`).get().n).toBe(1);
    expect(db.prepare(`SELECT bytes FROM listing_images WHERE listing_id = ?`).get('listing-1').bytes.toString()).toBe(
      'new',
    );
  });
});
