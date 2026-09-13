/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { renameListingHash } from '../storage/listingsStorage.js';
import { recordPriceChange } from './priceHistoryService.js';

/** @import { PriceChange } from '../../utils/formatListing.js' */

/**
 * Record a price the scrape read for an advert the link lane recognised, and move the row onto the
 * hash the advert now answers to.
 *
 * Most providers hash the price in, so a row left on its old hash is found again by the link lane on
 * every run, and a later return to its earlier price is swallowed by the hash lane. The row is renamed
 * even when the price has not moved: the price probe reads no hash, so it can change a row's price and
 * leave the old hash behind. A rename is not a reading - no history row, no notification. An
 * unreadable price moves neither.
 *
 * The price change and the rename share one transaction, so the row never keeps the price of one
 * reading and the hash of another.
 *
 * @param {{id: string, price: number|null, job_id?: string, jobId?: string}} listing The stored listing, before the change.
 * @param {number|null|undefined} newPrice The freshly read price.
 * @param {string} newHash The hash the advert now answers to.
 * @param {{source?: string, now?: number, thresholdPercent?: number}} [options] Passed to `recordPriceChange`.
 * @returns {PriceChange|null} The change when it clears the threshold, otherwise null.
 */
export const recordScrapedPriceChange = (listing, newPrice, newHash, options = {}) =>
  SqliteConnection.withTransaction(() => {
    const change = recordPriceChange(listing, newPrice, options);
    // The same guards `recordPriceChange` applies before it writes anything.
    if (listing?.id != null && Number.isFinite(newPrice) && newPrice > 0) renameListingHash(listing.id, newHash);
    return change;
  });
