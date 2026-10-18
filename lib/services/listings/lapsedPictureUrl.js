/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { updateListingImage } from '../storage/listingsStorage.js';
import logger from '../logger.js';

/**
 * The advert code a link ends with - `…/immobile/36711892/` as readily as `…/it/ad/123456789/`.
 * @type {RegExp}
 */
const ADVERT_CODE = /\/(\d+)\/?$/;

/**
 * A freshly signed picture url for a listing whose stored one has lapsed, or null.
 *
 * idealista signs each picture url for about a day, so the url a listing was stored with usually
 * no longer answers by the time its picture is kept from the image route. The advert itself is
 * still there, and asking for it returns a fresh url - which is also written back, so the
 * notifications and the portal fallback of the image route carry a working link. Every other
 * provider gets null: its url either answers or the picture is gone.
 *
 * Never throws: it is the second attempt of a capture that already failed.
 *
 * @param {string} listingId The listing's database id.
 * @returns {Promise<string|null>}
 */
export async function refreshLapsedPictureUrl(listingId) {
  try {
    const listing = SqliteConnection.query(`SELECT provider, link FROM listings WHERE id = ?`, [listingId])[0];
    if (listing?.provider !== 'idealista' || typeof listing.link !== 'string') return null;
    const code = listing.link.match(ADVERT_CODE)?.[1];
    if (code == null) return null;

    // Loaded on demand: the idealista client is only worth importing for an idealista listing.
    const { readAdvert } = await import('../idealista/search.js');
    const advert = await readAdvert(code, listing.link);
    const freshUrl = typeof advert?.thumbnail === 'string' && advert.thumbnail.length > 0 ? advert.thumbnail : null;
    if (freshUrl != null) updateListingImage(listingId, freshUrl);
    return freshUrl;
  } catch (error) {
    logger.debug(`Could not renew the picture url of listing ${listingId}: ${error.message}`);
    return null;
  }
}
