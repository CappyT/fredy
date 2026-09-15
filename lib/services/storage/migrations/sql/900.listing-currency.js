/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The currency a listing's price is written in.
 *
 * Until now every price was taken to be euros, which Flatfox's Swiss adverts are not. The column
 * lets every reader of `price` know which kind of number it holds - the notification that labels it,
 * the market benchmark that must not take the median of francs and euros together, the finance
 * model that only knows how to lend in euros.
 *
 * The column starts empty and stays nullable. Which currency a row is in follows from the country its
 * provider places it in, and a migration cannot ask the provider modules: they load after the
 * migrations have run. `backfillListingCurrency` fills existing rows once the providers are loaded,
 * and the pipeline writes the column for every listing it stores from then on. Until a row is
 * filled, every query reads NULL as the default currency, which is what the row was taken to be
 * before this column existed.
 *
 * Fork migration, hence the 900 range, and idempotent like every migration here.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(listings)`).all();
  if (!columns.some((column) => column.name === 'currency')) {
    db.exec(`ALTER TABLE listings ADD COLUMN currency TEXT`);
  }
}
