/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Give every stored listing a currency.
 *
 * Migration 900 added `listings.currency` as a nullable column, and the fork filled it at startup
 * from the provider's country. Upstream's migration 55 now owns the column and every query compares
 * it directly (`l.currency = @currency`), so a row still NULL would match no currency at all. The
 * startup backfill is gone, and this fills what it may have left.
 *
 * The Swiss sources are written out, as migration 55 does, because a migration has to keep meaning
 * what it meant when it ran: flatfox, homegate, immoscout24ch and the Swiss site of BETTERHOMES
 * price in francs, everything else in euros.
 *
 * Fork migration, hence the 900 range. Idempotent: it only touches rows that are still NULL.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(listings)`).all();
  if (!columns.some((column) => column.name === 'currency')) {
    return;
  }
  db.exec(
    `UPDATE listings
     SET currency = 'CHF'
     WHERE currency IS NULL
       AND (provider IN ('flatfox', 'homegate', 'immoscout24ch')
         OR (provider = 'betterhomes'
           AND (link LIKE 'https://www.betterhomes.ch/%' OR link LIKE 'https://betterhomes.ch/%')))`,
  );
  db.exec(`UPDATE listings SET currency = 'EUR' WHERE currency IS NULL`);
}
