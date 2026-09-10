/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import {
  getListingsMissingDetails,
  markDetailBackfillAttempt,
  updateListingDescription,
  updateListingPublishedAt,
} from '../storage/listingsStorage.js';
import { getUserSettings } from '../storage/settingsStorage.js';
import { config as tecnocasaConfig } from '../../provider/tecnocasa.js';
import { config as tecnoreteConfig } from '../../provider/tecnorete.js';
import { config as idealistaConfig } from '../../provider/idealista.js';
import { config as immobiliareConfig } from '../../provider/immobiliare.js';
import { sleep, nullOrEmpty } from '../../utils.js';
import logger from '../logger.js';

/**
 * How long to wait between two detail requests when the provider states no pace of its own.
 *
 * A sweep hands the whole back catalogue to one host at once, and two hundred requests as fast as
 * the network allows is the behaviour that earns a block - which is how a burst of new listings
 * ended up stored without their dates in the first place. The jitter keeps the gaps from being
 * identical.
 * @type {number}
 */
const SWEEP_DELAY_MS = 400;
const SWEEP_JITTER_MS = 300;

/**
 * Once a night. New listings get their description and their date at scrape time, so what is left
 * for the sweep is an upgrade's back catalogue and the batch a run stored while its detail reads
 * were being refused - neither of which is in a hurry.
 * @type {string}
 */
const DETAIL_BACKFILL_CRON = '30 4 * * *';

/**
 * Where a stored listing's missing columns can be read from, per provider.
 *
 * Each entry is the provider's own configuration - the same `fetchDetails` the pipeline runs at
 * scrape time, handed just the link a stored row carries - so a value a sweep reads lands on the
 * listing in the same words the scrape would have given it, and the provider's declared pacing
 * comes along with it. One read answers both columns where a provider has both: the description
 * and the portal's own date are two fields of the same page, and asking for them separately was
 * two requests per row at a host the code paces itself for.
 *
 * A provider whose detail read needs a browser, or that reads neither value anywhere, is left out
 * of the work list entirely rather than swept forever.
 *
 * @type {Record<string, import('../../types/providerConfig.js').ProviderConfig>}
 */
const enrichers = {
  tecnocasa: tecnocasaConfig,
  tecnorete: tecnoreteConfig,
  idealista: idealistaConfig,
  immobiliare: immobiliareConfig,
};

/**
 * What each swept provider is able to answer, as the work list is asked for it.
 *
 * The declaration is the provider's, not the sweep's: only `fetchDetails` knows what it sets, and
 * a table kept here would go stale the first time one of them learned or lost a field. Naming a
 * provider above without declaring anything on its config therefore excludes it - which is the
 * safe direction, because the alternative is a request per row per retry window for a column that
 * portal never returns. idealista is the case that produced this: its detail read sets the
 * publication date and nothing else, so every idealista advert stored without a description was
 * being re-read every fortnight for a text that was never coming.
 *
 * @returns {Record<string, string[]>} Provider id to the detail fields it fills, empty ones dropped.
 */
function detailFieldsByProvider() {
  const declared = {};
  for (const [provider, config] of Object.entries(enrichers)) {
    const fields = Array.isArray(config?.detailFields) ? config.detailFields.filter((f) => typeof f === 'string') : [];
    if (fields.length === 0) {
      logger.debug(`Detail backfill: '${provider}' declares no detail fields, so its rows are not swept.`);
      continue;
    }
    declared[provider] = fields;
  }
  return declared;
}

/**
 * Record an attempt, tolerating a database that is momentarily busy.
 *
 * The marker is bookkeeping, not the work: losing one costs the row an extra read on some later
 * sweep, while letting the write escape costs every row queued behind it.
 *
 * @param {string} id - The listing's row id.
 * @returns {void}
 */
function markAttempt(id) {
  try {
    markDetailBackfillAttempt(id);
  } catch (error) {
    logger.debug(`Detail backfill: could not mark ${id} as attempted (${error?.message}).`);
  }
}

/**
 * Guards against overlapping sweeps.
 *
 * The nightly cron and the startup sweep can both want the work, and two sweeps at once would read
 * the same adverts twice.
 * @type {boolean}
 */
let sweepRunning = false;

/**
 * Whether this row's owner has asked for that portal's detail pages to be fetched.
 *
 * The same opt-in the pipeline honours in `_fetchDetails`: reading a detail page costs a request
 * at the portal, so a user who ticked no portals must not have Fredy walking their back catalogue
 * on their behalf. Settings are read once per user rather than once per row - a sweep can carry a
 * thousand rows belonging to three accounts.
 *
 * A row whose owner has not opted in is marked as attempted all the same. That is a deliberate
 * trade: it used to be left untouched, so a later opt-in was acted on at the very next sweep, but
 * the work list is now capped per run and an un-marked row is handed out again on every single
 * tick - on an instance whose users have ticked nothing, the same few hundred rows filled the whole
 * batch forever and the rows of the users who *had* opted in were never reached. Marking costs a
 * newly ticked portal one retry window before its back catalogue is walked; not marking cost the
 * sweep the ability to make progress at all.
 *
 * @param {Map<string, string[]>} cache - Per-user opt-in lists, filled as the sweep goes.
 * @param {string|null|undefined} userId - The owner of the job the listing belongs to.
 * @param {string} provider - The portal the listing came from.
 * @returns {boolean}
 */
function mayReadDetails(cache, userId, provider) {
  if (!userId) return false;
  if (!cache.has(userId)) {
    const enabled = getUserSettings(userId)?.provider_details;
    cache.set(userId, Array.isArray(enabled) ? enabled : []);
  }
  return cache.get(userId).includes(provider);
}

/**
 * Fill in the description and the publication date of every stored listing whose provider can
 * still fetch them.
 *
 * One request per row, not two: both columns come off the same detail page. A row whose request
 * fails, or whose portal answers neither value, is still marked as attempted, so it rests for
 * `DETAIL_BACKFILL_RETRY_DAYS` instead of being re-read on every sweep from now until retention
 * deletes it.
 *
 * A no-op while another sweep is in flight - the running one will pick up anything this call would
 * have processed, because it reads the work list from the database as it goes.
 *
 * @param {Object} [options]
 * @param {number} [options.retryDays] - Override how long an attempted row rests. For tests.
 * @returns {Promise<boolean>} True when this call did the work, false when it was skipped.
 */
export async function runDetailBackfill({ retryDays } = {}) {
  if (sweepRunning) {
    logger.debug('Detail backfill already running. Skipping this trigger.');
    return false;
  }
  sweepRunning = true;
  try {
    const listings = getListingsMissingDetails(detailFieldsByProvider(), retryDays == null ? {} : { retryDays });
    if (listings.length === 0) return true;

    /** @type {Map<string, string[]>} */
    const optIn = new Map();
    const workable = [];
    for (const listing of listings) {
      if (mayReadDetails(optIn, listing.user_id, listing.provider)) workable.push(listing);
      // Marked without being read, so the capped batch is not filled by the same rows on every
      // tick. See `mayReadDetails` for what that costs a user who ticks the portal tomorrow.
      else markAttempt(listing.id);
    }
    if (workable.length === 0) {
      logger.debug(`Detail backfill: none of the ${listings.length} incomplete listings belong to an opted-in user.`);
      return true;
    }

    logger.info(`Detail backfill: reading ${workable.length} listings whose detail never arrived.`);
    let filled = 0;
    for (const listing of workable) {
      const provider = enrichers[listing.provider];
      const { detailFetchDelayMs = SWEEP_DELAY_MS, detailFetchJitterMs = SWEEP_JITTER_MS } = provider;
      // Paced from the first request, not from the second on as the pipeline's are: the pipeline
      // arrives at the host having just read a search page, the sweep arrives with a back catalogue.
      await sleep(detailFetchDelayMs + Math.random() * detailFetchJitterMs);
      try {
        // Before the read, so a request that never returns still counts. The marker is about what
        // was asked, not about what came back - and it is inside the try because it is a write to
        // a database another cron may hold busy at that instant, and one SQLITE_BUSY must cost the
        // sweep one row rather than every row after it.
        markDetailBackfillAttempt(listing.id);
        // `id` only ever reaches a log line inside the enrichers, but a warning naming the row is
        // the difference between a diagnosable sweep and one that says "an advert" a hundred times.
        const detail = await provider.fetchDetails({ id: listing.id, link: listing.link, description: null });
        let learned = false;
        if (listing.needs_description && !nullOrEmpty(detail?.description)) {
          updateListingDescription(listing.id, detail.description);
          learned = true;
        }
        if (listing.needs_published_at && Number.isFinite(detail?.publishedAt)) {
          updateListingPublishedAt(listing.id, detail.publishedAt);
          learned = true;
        }
        if (learned) filled += 1;
      } catch (error) {
        // One advert the portal would not answer - or one row the database would not let us write
        // to - is not a failed sweep; the rest go on.
        logger.debug(`Detail backfill: ${listing.id} could not be read (${error?.message}).`);
      }
    }
    logger.info(`Detail backfill: filled ${filled} of ${workable.length} listings.`);
    return true;
  } finally {
    sweepRunning = false;
  }
}

/**
 * Schedule the nightly detail backfill.
 *
 * Schedule only. The pass that repairs an upgrade's back catalogue is network-bound - minutes on
 * an instance with many rows - and it shares its hosts with the image backfill, so the startup run
 * is fired by `index.js`, which walks the two sweeps one after the other instead of pointing both
 * at the same portals at once.
 *
 * @returns {void}
 */
export function initListingDetailCron() {
  cron.schedule(DETAIL_BACKFILL_CRON, () => runDetailBackfill());
}
