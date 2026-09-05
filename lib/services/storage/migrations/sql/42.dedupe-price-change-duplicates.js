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
// One row survives per (job, link): the newest, which is the one whose price the portal is
// currently answering with. Everything a user attached to the losers is carried over - watches and
// price history are re-pointed onto the survivor (their primary keys are their own, so the move
// cannot collide), notes and status only fill blanks the survivor has. Travel times are the
// survivor's own; the losers' go with them, and everything else hanging off a deleted row follows
// the same cascade.

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
     ORDER BY created_at DESC, rowid DESC`,
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
