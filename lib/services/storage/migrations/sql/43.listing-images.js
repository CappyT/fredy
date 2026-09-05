/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// Migration: the listing photograph, stored instead of borrowed.
//
// The image url a scrape records is a rental: idealista signs its cloudfront links for about a
// day, and the other portals take photographs down the moment an advert changes - so a gallery
// built on the portals' urls decays on their schedule, not on Fredy's. From here every scrape
// downloads the image once and keeps the bytes, and the listing detail serves them from this
// instance. The table stands alone rather than as a column on listings so the listing queries
// never drag a blob along by accident; ON DELETE CASCADE follows the price-history precedent.

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_images (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      mime_type  TEXT NOT NULL,
      bytes      BLOB NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);
}
