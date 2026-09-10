/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// Migration: collapse the duplicates a price change used to leave behind.
//
// A listing's hash is built over the portal's advert id *and its price*, so an advert that dropped
// its price hashed differently and was stored a second time under the same link - notified as new,
// while the row already carrying the link stayed active beside it with its stale price. The
// pipeline now recognises the advert by its link and moves the price onto the row it already has;
// this migration removes the rows that piled up before it did.
//
// One row survives per (job, link): a visible one if the group has any, and the newest among
// those. Newest alone was not enough - a user who hid the stale row and kept the fresh one would
// have had the hidden row win whenever it happened to be the later of the two, which puts the
// advert back out of sight and takes the visible row's history with it.
//
// Everything a user attached to the losers is carried over - price history is re-pointed onto the
// survivor, notes and status only fill blanks the survivor has. Watches are re-pointed too, but
// `idx_watch_list` is unique on (listing_id, user_id): a user who starred both duplicates has a
// row on each, and moving the second onto the survivor collides. Those duplicates are dropped
// first - the user already watches the survivor, so nothing is lost - and only the watches that
// have nowhere to collide are moved. The collision used to abort the migration, which rolls it
// back and stops Fredy from starting at all.
//
// Travel times are the survivor's own; the losers' go with them, and everything else hanging off a
// deleted row follows the same cascade.

export function up(db) {
  const groups = db
    .prepare(
      `SELECT job_id, link
       FROM listings
       WHERE link IS NOT NULL
       GROUP BY job_id, link
       HAVING COUNT(*) > 1`,
    )
    .all();
  if (groups.length === 0) return;

  const rowsOfGroup = db.prepare(
    `SELECT id, notes, status
     FROM listings
     WHERE job_id = ? AND link = ?
     ORDER BY COALESCE(manually_deleted, 0) ASC, created_at DESC, rowid DESC`,
  );
  const dropCollidingWatches = db.prepare(
    `DELETE FROM watch_list
     WHERE listing_id = @loser
       AND user_id IN (SELECT user_id FROM watch_list WHERE listing_id = @survivor)`,
  );
  const repointWatch = db.prepare(`UPDATE watch_list SET listing_id = ? WHERE listing_id = ?`);
  const repointHistory = db.prepare(`UPDATE listing_price_history SET listing_id = ? WHERE listing_id = ?`);
  const dropTravelTimes = db.prepare(`DELETE FROM listing_travel_times WHERE listing_id = ?`);
  const copyNote = db.prepare(`UPDATE listings SET notes = ? WHERE id = ? AND notes IS NULL`);
  const copyStatus = db.prepare(`UPDATE listings SET status = ? WHERE id = ? AND status IS NULL`);
  const remove = db.prepare(`DELETE FROM listings WHERE id = ?`);

  for (const group of groups) {
    const rows = rowsOfGroup.all(group.job_id, group.link);
    const survivor = rows[0];
    for (const loser of rows.slice(1)) {
      // A star the user already put on the survivor is the same star; the loser's copy of it would
      // trip the unique index the moment it moved.
      dropCollidingWatches.run({ loser: loser.id, survivor: survivor.id });
      repointWatch.run(survivor.id, loser.id);
      repointHistory.run(survivor.id, loser.id);
      // The journeys are keyed by (listing, label) and belong to the row they were computed for,
      // so they go with their row rather than being moved onto the survivor's shapes.
      dropTravelTimes.run(loser.id);
      copyNote.run(loser.notes, survivor.id);
      copyStatus.run(loser.status, survivor.id);
      remove.run(loser.id);
    }
  }
}
