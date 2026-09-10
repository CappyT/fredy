/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Remember when a listing's detail page was last read for the columns a scrape left empty.
 *
 * The nightly backfill's work list is "every active row whose provider can still fill a column it
 * is missing", and without a marker that list never shrinks for the rows nobody can answer: an
 * advert whose page is gone, one whose portal states no date, one the host refuses. Those were
 * re-read every single night, forever, against the very hosts the sweep paces itself for.
 *
 * The column records the *attempt*, not the answer, which is the whole point - a row that was
 * asked and gave nothing has to fall off the list for a while just as surely as one that gave
 * everything. NULL means "never attempted" and leads an ascending sort, so nothing is starved.
 *
 * The index is what the sweep's query is actually served by, so it is shaped like the query rather
 * than like the column. Two things follow from that:
 *
 * - It is partial. Every row the sweep will ever consider is active, not hidden, and has a link;
 *   an index over the whole table would carry the gone and the hidden adverts - on an instance
 *   with a retention window that is most of the table - for a walk that skips all of them.
 * - It carries `created_at` after the marker, in the order the sweep asks for them. That pair *is*
 *   `ORDER BY detail_backfill_at, created_at DESC`, so the batch can be taken by walking the index
 *   and stopping at the limit, instead of materialising every incomplete listing in the database
 *   and sorting it in a temporary b-tree before the first request goes out.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(listings)`).all();
  if (!columns.some((column) => column.name === 'detail_backfill_at')) {
    db.exec(`ALTER TABLE listings ADD COLUMN detail_backfill_at INTEGER`);
  }
  // Dropped first: the same name was briefly a plain index on the marker alone, which serves the
  // filter but not the order, and `IF NOT EXISTS` would have kept it.
  db.exec(`
    DROP INDEX IF EXISTS idx_listings_detail_backfill;
    CREATE INDEX IF NOT EXISTS idx_listings_detail_backfill
      ON listings (detail_backfill_at, created_at DESC)
      WHERE is_active = 1 AND manually_deleted = 0 AND link IS NOT NULL;
  `);
}
