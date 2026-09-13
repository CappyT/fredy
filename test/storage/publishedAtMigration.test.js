/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { up } from '../../lib/services/storage/migrations/sql/42.listing-published-at.js';

/**
 * Instances of the italy fork added `published_at` under migration 41, a name this migration does
 * not match, so the runner applies it to a table that already has the column.
 */
describe('migration 42 - listing published at', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, created_at INTEGER)`);
  });

  afterEach(() => db.close());

  const columns = () =>
    db
      .prepare(`PRAGMA table_info(listings)`)
      .all()
      .map((column) => column.name);

  it('adds the column', () => {
    up(db);
    expect(columns()).toContain('published_at');
  });

  it('leaves an existing column and its values alone', () => {
    db.exec(`ALTER TABLE listings ADD COLUMN published_at INTEGER`);
    db.prepare(`INSERT INTO listings (id, created_at, published_at) VALUES (?,?,?)`).run('a', 2, 1);

    expect(() => up(db)).not.toThrow();
    expect(columns().filter((name) => name === 'published_at')).toHaveLength(1);
    expect(db.prepare(`SELECT published_at FROM listings WHERE id = ?`).get('a').published_at).toBe(1);
  });
});
