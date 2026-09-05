/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getListingsMissingStoredImage, updateListingImage, storeListingImage } from '../storage/listingsStorage.js';
import { readAdvert } from '../idealista/search.js';
import { fetchListingImage } from './imageFetcher.js';
import { sleep } from '../../utils.js';
import logger from '../logger.js';

/**
 * How long to wait between two downloads.
 *
 * The request is the one a browser makes when it renders a listing page, but a sweep walks the
 * whole back catalogue in one go and two hundred photographs as fast as the network allows is
 * still behaviour worth pacing. The jitter keeps the gaps from being identical.
 * @type {number}
 */
const SWEEP_DELAY_MS = 400;
const SWEEP_JITTER_MS = 300;

/**
 * The advert code a link ends with - `…/immobile/36711892/` as readily as `…/it/ad/123456789/`.
 * @type {RegExp}
 */
const ADVERT_CODE = /\/(\d+)\/?$/;

/**
 * Guards against overlapping sweeps.
 * @type {boolean}
 */
let sweepRunning = false;

/**
 * Keep the photograph of a listing whose url still answers, or, for the portals that sign their
 * urls and have since let them lapse, ask for a fresh one first.
 *
 * @param {{id: string, link: string, image_url: string, provider: string}} listing The stored row.
 * @returns {Promise<boolean>} Whether the bytes were kept.
 */
async function keepImage(listing) {
  let image = await fetchListingImage(listing.image_url);

  if (image == null && listing.provider === 'idealista') {
    // idealista signs each image url for about a day, so a stored one is usually expired by the
    // time this sweep reaches it. The advert itself is still there, and asking for it returns a
    // freshly signed url - which is also written back, so the notifications carry a working link.
    const code = listing.link.match(ADVERT_CODE)?.[1];
    if (code != null) {
      const advert = await readAdvert(code);
      const freshUrl = typeof advert?.thumbnail === 'string' && advert.thumbnail.length > 0 ? advert.thumbnail : null;
      if (freshUrl != null) {
        image = await fetchListingImage(freshUrl);
        if (image != null) updateListingImage(listing.id, freshUrl);
      }
    }
  }

  if (image == null) return false;
  storeListingImage(listing.id, image.mimeType, image.bytes);
  return true;
}

/**
 * Download and keep the photograph of every active listing that has a url but no stored bytes.
 *
 * The scrape keeps the bytes of every listing as it is stored, so this sweep's work list is the
 * backlog an instance upgraded with; it shrinks with every run and stays empty once it has caught
 * up. It runs at startup, un-awaited, and never on a schedule - a photograph that failed to
 * download is picked up the next time the instance starts, and one the portal no longer serves
 * will simply wait.
 *
 * @returns {Promise<boolean>} True when this call did the work, false when it was skipped.
 */
export async function runImageBackfill() {
  if (sweepRunning) {
    logger.debug('Image backfill already running. Skipping this trigger.');
    return false;
  }
  sweepRunning = true;
  try {
    const listings = getListingsMissingStoredImage(['idealista', 'immobiliare', 'tecnocasa', 'tecnorete', 'casa', 'subito']);
    if (listings.length === 0) return true;

    logger.info(`Image backfill: keeping ${listings.length} listings' photographs.`);
    let kept = 0;
    for (const listing of listings) {
      await sleep(SWEEP_DELAY_MS + Math.random() * SWEEP_JITTER_MS);
      try {
        if (await keepImage(listing)) kept += 1;
      } catch (error) {
        // One photograph the portal would not serve is not a failed sweep; the rest go on.
        logger.debug(`Image backfill: ${listing.id} could not be kept (${error?.message}).`);
      }
    }
    logger.info(`Image backfill: kept ${kept} of ${listings.length} photographs.`);
    return true;
  } finally {
    sweepRunning = false;
  }
}
