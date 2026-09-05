/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import { getListingsMissingPublishedAt, updateListingPublishedAt } from '../storage/listingsStorage.js';
import { config as tecnocasaConfig } from '../../provider/tecnocasa.js';
import { config as tecnoreteConfig } from '../../provider/tecnorete.js';
import { config as idealistaConfig } from '../../provider/idealista.js';
import { config as immobiliareConfig } from '../../provider/immobiliare.js';
import { sleep } from '../../utils.js';
import logger from '../logger.js';

/**
 * How long to wait between two detail requests.
 *
 * The sweep exists because a run that found a hundred new listings at once had its detail reads
 * refused partway through the batch, so the requests it sends are paced from the first, not from
 * the second on as the pipeline's are. The jitter keeps the gaps from being identical.
 * @type {number}
 */
const SWEEP_DELAY_MS = 400;
const SWEEP_JITTER_MS = 300;

/**
 * Once a night, after the description sweep. New listings get their date at scrape time, so what
 * is left for this sweep is the batch that was stored mid-refusal - which the next job run would
 * never touch again, because the pipeline enriches only what it has not stored yet.
 * @type {string}
 */
const PUBLISHED_AT_BACKFILL_CRON = '50 4 * * *';

/**
 * Where the publication date of a stored listing can be read from, per provider.
 *
 * Each enricher is the provider's own detail read - the same code the pipeline runs at scrape
 * time, handed just the link a stored row carries - which is why the date a sweep reads lands on
 * the listing in the same words the scrape would have given it. A provider whose detail read
 * needs a browser, or that reads no date anywhere, is left out of the work list entirely rather
 * than swept forever.
 *
 * @type {Record<string, (listing: {id: string, link: string}) => Promise<number|undefined>>}
 */
const enrichers = {
  tecnocasa: async (listing) => (await tecnocasaConfig.fetchDetails({ link: listing.link }))?.publishedAt,
  tecnorete: async (listing) => (await tecnoreteConfig.fetchDetails({ link: listing.link }))?.publishedAt,
  idealista: async (listing) => (await idealistaConfig.fetchDetails({ link: listing.link }))?.publishedAt,
  immobiliare: async (listing) => (await immobiliareConfig.fetchDetails({ link: listing.link }))?.publishedAt,
};

/**
 * Guards against overlapping sweeps.
 *
 * The nightly cron and the startup sweep can both want the work, and two sweeps at once would
 * read the same adverts twice.
 * @type {boolean}
 */
let sweepRunning = false;

/**
 * Fill in the publication date of every stored listing whose provider can still fetch it.
 *
 * A no-op while another sweep is in flight. A listing whose detail request fails this night stays
 * on the list and is read again the next one - which is what keeps a listing discovered during a
 * block from being dateless forever.
 *
 * @returns {Promise<boolean>} True when this call did the work, false when it was skipped.
 */
export async function runPublishedAtBackfill() {
  if (sweepRunning) {
    logger.debug('Publication date backfill already running. Skipping this trigger.');
    return false;
  }
  sweepRunning = true;
  try {
    const listings = getListingsMissingPublishedAt(Object.keys(enrichers));
    if (listings.length === 0) return true;

    logger.info(`Publication date backfill: reading ${listings.length} listings whose date never arrived.`);
    let filled = 0;
    for (const listing of listings) {
      await sleep(SWEEP_DELAY_MS + Math.random() * SWEEP_JITTER_MS);
      try {
        const publishedAt = await enrichers[listing.provider](listing);
        if (Number.isFinite(publishedAt)) {
          updateListingPublishedAt(listing.id, publishedAt);
          filled += 1;
        }
      } catch (error) {
        // One advert the portal would not answer is not a failed sweep; the rest go on.
        logger.debug(`Publication date backfill: ${listing.id} could not be read (${error?.message}).`);
      }
    }
    logger.info(`Publication date backfill: filled ${filled} of ${listings.length} listings.`);
    return true;
  } finally {
    sweepRunning = false;
  }
}

export function initListingPublishedAtCron() {
  // The first sweep is what repairs the rows a throttled run already stored, and it is
  // network-bound - minutes on an instance with many rows - so it runs in the background rather
  // than holding the startup. The nightly schedule takes the leftovers.
  runPublishedAtBackfill();
  cron.schedule(PUBLISHED_AT_BACKFILL_CRON, runPublishedAtBackfill);
}
