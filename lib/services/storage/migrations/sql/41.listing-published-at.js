/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// Migration: the date the portal itself attaches to an advert.
//
// Fredy's own created_at is when this instance first saw the listing, which is a different thing:
// a flat published two weeks ago and only discovered today reads as brand new. The portals that
// state their own date - casa.it in the search answer, idealista.it as firstActivationDate,
// immobiliare.it on the android app's property detail - now have somewhere to put it, and the
// listing list orders by it, falling back to created_at where it is missing.

export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN published_at INTEGER;
  `);
}
