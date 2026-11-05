/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { up as up900 } from '../../lib/services/storage/migrations/sql/900.listing-currency.js';
import { up as up902 } from '../../lib/services/storage/migrations/sql/902.listing-currency-fill.js';
import { currencyForLink } from '../../lib/services/providers/currency.js';
import { metaInformation as homegate } from '../../lib/provider/homegate.js';
import { metaInformation as immoscout24ch } from '../../lib/provider/immoscout24ch.js';

/**
 * The fork's own currency pieces, now that upstream's migration 55 owns `listings.currency`: the
 * nullable column migration 900 added on a fork database, the fill migration 902 runs over it, and
 * the Swiss providers only the fork ships.
 */
describe('fork listing currency', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, provider TEXT, link TEXT, price REAL)`);
  });

  afterEach(() => db.close());

  const currencyOf = (id) => db.prepare(`SELECT currency FROM listings WHERE id = ?`).get(id).currency;

  it('fills the rows migration 900 left empty, francs for the Swiss sources', () => {
    up900(db);
    const insert = db.prepare(`INSERT INTO listings (id, provider, link, price) VALUES (?, ?, ?, 1000)`);
    insert.run('hg', 'homegate', 'https://www.homegate.ch/rent/1');
    insert.run('is', 'immoscout24ch', 'https://www.immoscout24.ch/rent/1');
    insert.run('ff', 'flatfox', 'https://flatfox.ch/en/flat/1/');
    insert.run('bh-ch', 'betterhomes', 'https://www.betterhomes.ch/immobilien/1');
    insert.run('bh-de', 'betterhomes', 'https://www.betterhomes.de/immobilien/1');
    insert.run('im', 'immobiliare', 'https://www.immobiliare.it/annunci/1/');

    up902(db);

    expect(['hg', 'is', 'ff', 'bh-ch'].map(currencyOf)).toEqual(['CHF', 'CHF', 'CHF', 'CHF']);
    expect(['bh-de', 'im'].map(currencyOf)).toEqual(['EUR', 'EUR']);
  });

  it('leaves a row that already has a currency alone, and runs twice without complaint', () => {
    up900(db);
    db.prepare(`INSERT INTO listings (id, provider, link, currency) VALUES ('x', 'homegate', null, 'EUR')`).run();
    up902(db);
    expect(() => up902(db)).not.toThrow();
    expect(currencyOf('x')).toBe('EUR');
  });

  it('does nothing on a database without the column', () => {
    expect(() => up902(db)).not.toThrow();
  });

  it('prices homegate and immoscout24ch in francs', () => {
    expect(currencyForLink(homegate, 'https://www.homegate.ch/rent/1')).toBe('CHF');
    expect(currencyForLink(immoscout24ch, 'https://www.immoscout24.ch/rent/1')).toBe('CHF');
  });
});
