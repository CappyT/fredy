/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import { getListingsMissingDescription, updateListingDescription } from '../storage/listingsStorage.js';
import { advertIdInLink, fetchPropertyDetail, detailDescription } from '../immobiliare/propertyDetail.js';
import { sleep } from '../../utils.js';
import logger from '../logger.js';

/**
 * How long to wait between two detail requests.
 *
 * The app api is not the half of the portal that guards itself, but an instance that upgrades into
 * this sweep hands it its whole back catalogue at once, and two hundred requests as fast as the
 * network allows is the behaviour that earns a block. The jitter keeps the gaps from being
 * identical.
 * @type {number}
 */
const SWEEP_DELAY_MS = 400;
const SWEEP_JITTER_MS = 300;

/**
 * Once a night. New listings get their description at scrape time, so what is left for the sweep is
 * an upgrade's back catalogue and the odd listing whose detail request failed - neither of which
 * is in a hurry.
 * @type {string}
 */
const DESCRIPTION_BACKFILL_CRON = '30 4 * * *';

/**
 * Where the description of a listing the search payload left empty can be read from, per provider.
 *
 * The stored row only says which provider found it and what its link is; turning that into a
 * description is provider knowledge, and a provider that knows no such place is left out of the
 * work list entirely rather than swept forever.
 *
 * @type {Record<string, (listing: {id: string, link: string}) => Promise<string|null>>}
 */
const enrichers = {
  immobiliare: async (listing) => {
    const advertId = advertIdInLink(listing.link);
    if (advertId == null) return null;
    return detailDescription(await fetchPropertyDetail(advertId));
  },
};

/**
 * Guards against overlapping sweeps.
 *
 * The nightly cron and a startup that just upgraded into the feature can both want the work, and
 * two sweeps at once would read the same adverts twice.
 * @type {boolean}
 */
let sweepRunning = false;

/**
 * Fill in the description of every stored listing whose provider can still fetch it.
 *
 * A no-op while another sweep is in flight - the running one will pick up anything this call would
 * have processed, because it reads the work list from the database as it goes. A listing whose
 * detail request fails this night stays on the list and is read again the next one.
 *
 * @returns {Promise<boolean>} True when this call did the work, false when it was skipped.
 */
export async function runDescriptionBackfill() {
  if (sweepRunning) {
    logger.debug('Description backfill already running. Skipping this trigger.');
    return false;
  }
  sweepRunning = true;
  try {
    const listings = getListingsMissingDescription(Object.keys(enrichers));
    if (listings.length === 0) return true;

    logger.info(`Description backfill: reading ${listings.length} listings whose description never arrived.`);
    let filled = 0;
    for (const listing of listings) {
      await sleep(SWEEP_DELAY_MS + Math.random() * SWEEP_JITTER_MS);
      try {
        const description = await enrichers[listing.provider](listing);
        if (description != null) {
          updateListingDescription(listing.id, description);
          filled += 1;
        }
      } catch (error) {
        // One advert the portal would not describe is not a failed sweep; the rest go on.
        logger.debug(`Description backfill: ${listing.id} could not be read (${error?.message}).`);
      }
    }
    logger.info(`Description backfill: filled ${filled} of ${listings.length} listings.`);
    return true;
  } finally {
    sweepRunning = false;
  }
}

export function initListingDescriptionCron() {
  // The first sweep is what repairs the back catalogue an instance upgraded with, and it is
  // network-bound - minutes on an instance with many rows - so it runs in the background rather
  // than holding the startup. The nightly schedule takes the leftovers.
  runDescriptionBackfill();
  cron.schedule(DESCRIPTION_BACKFILL_CRON, runDescriptionBackfill);
}
