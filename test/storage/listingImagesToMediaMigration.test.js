/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { up as createForkTable } from '../../lib/services/storage/migrations/sql/43.listing-images.js';
import { up as createMediaTable } from '../../lib/services/storage/migrations/sql/48.listing-media.js';
import { up } from '../../lib/services/storage/migrations/sql/901.listing-images-to-media.js';

let db;

describe('migration 901 - fork photographs into listing_media', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (id TEXT PRIMARY KEY);
      INSERT INTO listings (id) VALUES ('kept'), ('upstream'), ('none');
    `);
    createForkTable(db);
    createMediaTable(db);
    const insert = db.prepare(
      `INSERT INTO listing_images (listing_id, mime_type, bytes, fetched_at) VALUES (?, 'image/jpeg', ?, 1)`,
    );
    insert.run('kept', Buffer.from('fork'));
    insert.run('upstream', Buffer.from('fork'));
    db.prepare(
      `INSERT INTO listing_media (listing_id, preview_mime, created_at, preview) VALUES ('upstream', 'image/webp', 2, ?)`,
    ).run(Buffer.from('webp'));
  });

  it('copies the kept bytes, leaves upstream previews alone and drops the fork table', () => {
    up(db);

    const rows = db.prepare(`SELECT listing_id, preview_mime, preview FROM listing_media ORDER BY listing_id`).all();
    expect(rows.map((r) => [r.listing_id, r.preview_mime, r.preview.toString()])).toEqual([
      ['kept', 'image/jpeg', 'fork'],
      ['upstream', 'image/webp', 'webp'],
    ]);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'listing_images'`).get()).toBeUndefined();
  });

  it('runs twice without complaint', () => {
    up(db);
    expect(() => up(db)).not.toThrow();
  });
});
