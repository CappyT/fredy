/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { applyMarketBenchmark, applyScamSignals } from '../storage/listingsStorage.js';
import { currencyForListing } from '../providers/providerCurrency.js';
import { DEFAULT_CURRENCY } from '../../utils/currency.js';

/**
 * Give every stored listing without a currency the one its provider's country pays in.
 *
 * Migration 900 adds the column empty, because the provider modules that know the countries load
 * after the migrations have run. This fills it once they have: the pipeline writes the column for
 * every listing it stores, so after the first start the work list is empty and the pass costs one
 * query per provider.
 *
 * A listing that turns out not to be in euros was benchmarked, before this, against every neighbour
 * whatever its currency. Its market median is thrown away and measured again against listings in its
 * own currency only, and its scam signals are read again after it, since one of them compares the
 * price against that median. A euro listing near the border keeps a median that may have counted a
 * few franc neighbours: finding those would mean re-measuring every listing within fifteen kilometres
 * of every franc listing, for a figure that moves by a few of the dozens of neighbours it is taken
 * over.
 *
 * Never throws. A failure costs the currency labels and leaves those rows reading as euros, which is
 * what they were until now, and must not stop Fredy from starting.
 *
 * @param {Array<{metaInformation?: {id?: string, countries?: unknown, countryOf?: Function}}>} providers
 *   The loaded provider modules.
 * @returns {{filled: number, relabelled: number}} Rows given a currency, and how many of them are not
 *   in the default one.
 */
export function backfillListingCurrency(providers) {
  const result = { filled: 0, relabelled: 0 };
  try {
    const relabelledIds = [];
    SqliteConnection.withTransaction((db) => {
      for (const provider of providers ?? []) {
        const meta = provider?.metaInformation;
        if (typeof meta?.id !== 'string' || meta.id.length === 0) continue;

        const rows = db
          .prepare(`SELECT id, link FROM listings WHERE provider = @provider AND currency IS NULL`)
          .all({ provider: meta.id });
        if (rows.length === 0) continue;

        const write = db.prepare(`UPDATE listings SET currency = @currency WHERE id = @id`);
        for (const row of rows) {
          // Per row, because a provider covering several markets may narrow each advert to one
          // country - and with it to one currency - off its own link.
          const currency = currencyForListing(meta, row);
          write.run({ id: row.id, currency });
          if (currency !== DEFAULT_CURRENCY) relabelledIds.push(row.id);
        }
        result.filled += rows.length;
      }
    });
    result.relabelled = relabelledIds.length;

    if (relabelledIds.length > 0) {
      remeasure(relabelledIds);
    }
    if (result.filled > 0) {
      logger.info(
        `Labelled ${result.filled} stored listings with their currency (${result.relabelled} not in ${DEFAULT_CURRENCY}).`,
      );
    }
  } catch (error) {
    logger.warn('Could not label the stored listings with their currency.', error);
  }
  return result;
}

/**
 * Benchmark relabelled listings again against their own currency, and re-read their scam signals.
 *
 * @param {string[]} ids Listings whose currency is not the default one.
 * @returns {void}
 */
function remeasure(ids) {
  const byJob = new Map();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const placeholders = chunk.map(() => '?').join(',');
    // The old figure was taken over the wrong sample, so it goes whether or not a new one is found:
    // too few neighbours in the listing's own currency means no benchmark, not the mixed one.
    SqliteConnection.execute(
      `UPDATE listings
       SET market_median_sqm = NULL, market_sample_size = NULL, market_radius_km = NULL
       WHERE id IN (${placeholders})`,
      chunk,
    );
    const rows = SqliteConnection.query(
      `SELECT id, job_id, latitude, longitude, currency, title, description, price_per_sqm
       FROM listings
       WHERE id IN (${placeholders}) AND manually_deleted = 0`,
      chunk,
    );
    for (const row of rows) {
      if (!byJob.has(row.job_id)) byJob.set(row.job_id, []);
      byJob.get(row.job_id).push({ ...row, market_median_sqm: null });
    }
  }

  for (const [jobId, listings] of byJob) {
    applyMarketBenchmark(jobId, listings);
    applyScamSignals(listings);
  }
}
