/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../lib/services/storage/migrations/sql/900.listing-currency.js';

/**
 * The column every price reader asks which currency a listing is in. It starts empty, because the
 * providers that know the answer load after the migrations, and it has to survive running twice.
 */
describe('migration 900 - listing currency', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (id TEXT PRIMARY KEY, price REAL);
      INSERT INTO listings (id, price) VALUES ('listing-1', 2710);
    `);
  });

  afterEach(() => db.close());

  const columns = () =>
    db
      .prepare(`PRAGMA table_info(listings)`)
      .all()
      .map((column) => column.name);

  it('adds the column, empty on every existing row', () => {
    up(db);
    expect(columns()).toContain('currency');
    expect(db.prepare(`SELECT currency FROM listings`).get().currency).toBeNull();
  });

  it('runs twice without complaint', () => {
    up(db);
    expect(() => up(db)).not.toThrow();
    expect(columns().filter((name) => name === 'currency')).toHaveLength(1);
  });
});
