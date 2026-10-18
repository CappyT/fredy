/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Hand the fork's kept photographs over to upstream's `listing_media`, then drop the fork's table.
 *
 * Migration 43 kept the first picture of a listing in `listing_images`; upstream's 48 keeps the same
 * picture in `listing_media.preview`. The bytes are copied as they are rather than re-encoded as
 * WebP: the image route serves whatever `preview_mime` names, and a listing that already has a
 * preview of upstream's keeps it. Idempotent - on a second run the fork's table is gone.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  const hasForkTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listing_images'`).get();
  if (!hasForkTable) return;

  db.exec(`
    INSERT INTO listing_media (listing_id, preview_mime, created_at, preview)
    SELECT listing_id, mime_type, fetched_at, bytes FROM listing_images WHERE true
    ON CONFLICT(listing_id) DO UPDATE SET
      preview = excluded.preview,
      preview_mime = excluded.preview_mime,
      preview_failed_at = NULL
    WHERE listing_media.preview IS NULL;

    DROP TABLE listing_images;
  `);
}
