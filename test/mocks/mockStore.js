/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-unused-vars */
const db = {};
export const storeListings = (jobKey, providerId, listings) => {
  if (!Array.isArray(listings)) throw Error('Not a valid array');
  db[`${jobKey}|${providerId}`] = listings;
};
/**
 * The hashes one job still recognises.
 *
 * Mirrors the real query's liveness rule, which is the whole point of having one here: a row the
 * alive-checker declared gone is forgotten, so a repost reaches the link lane and is stored, while
 * a row the user hid stays remembered however dead it is, so a scrape never rediscovers it. The
 * two lanes of the novelty check have to agree, and a mock that agreed with neither hid the bug.
 *
 * @param {string} jobKey
 * @returns {string[]}
 */
export const getKnownListingHashesForJob = (jobKey) => {
  return Object.entries(db)
    .filter(([key]) => key.startsWith(`${jobKey}|`))
    .flatMap(([, listings]) => listings)
    .filter((listing) => listing?.manually_deleted === 1 || listing?.is_active == null || listing?.is_active === 1)
    .map((listing) => listing?.id)
    .filter((id) => id != null);
};

/**
 * Forget every stored listing.
 *
 * What the real store keeps is memory across runs, which a test running the same listings again is
 * not asking to inherit from the case before it.
 * @returns {void}
 */
export const resetListings = () => {
  for (const key of Object.keys(db)) delete db[key];
  recordedPriceObservations.length = 0;
  appliedPriceChanges.length = 0;
  renamedHashes.length = 0;
  storedImages.length = 0;
  updatedImages.length = 0;
};

export const getGeocoordinatesByAddress = (any) => {
  return null;
};

/**
 * Every address the pipeline asked the geocoder about, in order.
 *
 * A test that cares whether a geocode happened at all needs to see the absence of a call, which a
 * plain stub cannot show.
 * @type {string[]}
 */
export const geocodedAddresses = [];

/** What the stand-in geocoder answers. Set by a test that needs coordinates back. */
export let geocodeResult = null;

/**
 * @param {{lat: number, lng: number}|null} result
 * @returns {void}
 */
export function setGeocodeResult(result) {
  geocodeResult = result;
}

/**
 * Stands in for `geoCodingService.geocodeAddress`, recording what it was asked.
 *
 * @param {string} address
 * @returns {{lat: number, lng: number}|null}
 */
export const geocodeAddress = (address) => {
  geocodedAddresses.push(address);
  return geocodeResult;
};

let userSettings = null;
export function setUserSettings(settings) {
  userSettings = settings;
}
export function getUserSettings(userId) {
  return userSettings;
}

export async function getSettings() {
  return { baseUrl: '' };
}

export function getAddresses(settings) {
  if (Array.isArray(settings?.home_addresses)) return settings.home_addresses;
  if (settings?.home_address?.coords) return [{ label: 'Home', ...settings.home_address }];
  return [];
}

export const updateListingDistances = (id, distances) => {
  // noop
};
/**
 * The real one reads the stored journeys back onto the listings after a sweep. A test that wants
 * travel times puts them on the listing itself, so here this only has to leave them alone.
 */
export const attachTravelTimes = (listings) => listings;
export const deletedIds = [];
export const deleteListingsById = (ids) => {
  deletedIds.push(...ids);
};
export const deleteListingsByHash = (hashes) => {
  deletedIds.push(...hashes);
};
/**
 * The real one reads every stored listing around each new one to work out what a square metre costs
 * there. There is no table behind these mocks to read, and no assertion in the pipeline tests looks
 * at the figures, so here it only has to exist - the pipeline calls it on every run.
 */
export const applyMarketBenchmark = (jobId, listings) => {
  // noop
};

/**
 * Every photograph the pipeline kept, in order.
 *
 * The image step runs after the store, keyed on the row id `storeListings` propagated onto each
 * listing; a test that cares whether the scrape downloaded the photograph asserts on these.
 * @type {{listingId: string, mimeType: string, size: number}[]}
 */
export const storedImages = [];
export const storeListingImage = (listingId, mimeType, bytes) => {
  storedImages.push({ listingId, mimeType, size: bytes?.length ?? 0 });
};

export const getListingImage = () => null;

export const getListingsMissingStoredImage = () => [];

/**
 * The nightly sweeps' work lists and their attempt marker.
 *
 * The pipeline never calls these, but this module stands in for the whole storage layer, and an
 * export that is missing here throws the moment anything reaches for it.
 */
export const getListingsMissingDetails = () => [];
export const markDetailBackfillAttempt = () => {};
export const updateListingDescription = () => {};
export const updateListingPublishedAt = () => {};

/**
 * Every fresh image url written back onto a listing.
 * @type {{id: string, imageUrl: string}[]}
 */
export const updatedImages = [];
export const updateListingImage = (id, imageUrl) => {
  updatedImages.push({ id, imageUrl });
};

/**
 * Every price reading the pipeline recorded through the price-change lane, in order.
 *
 * The link-identity check in `_findNew` routes a re-read of an already stored advert through
 * `recordPriceChange`, whose storage half lands here; a test that cares whether the advert was
 * recognised instead of re-stored asserts on these.
 * @type {{listingId: string, price: number, source: string|null}[]}
 */
export const recordedPriceObservations = [];
export const recordPriceObservation = (listingId, price, observedAt = Date.now(), source = null) => {
  recordedPriceObservations.push({ listingId, price, observedAt, source });
};

/**
 * Every applied price change, in order.
 *
 * `newHash` is part of the record because most providers hash the price in: the row has to take
 * the name the portal now answers with, or the next run's hash lane no longer recognises it.
 * @type {{listingId: string, newPrice: number, changedAt: number, newHash: string|null}[]}
 */
export const appliedPriceChanges = [];
export const applyPriceChange = (listingId, newPrice, changedAt = Date.now(), newHash = null) => {
  appliedPriceChanges.push({ listingId, newPrice, changedAt, newHash });
  // The real table keeps the row's primary key and moves its `hash` column; this store has one
  // field standing in for both, so the stored row takes the new name here. Without it a later run
  // would still be looking for the advert under the hash the portal has stopped answering with.
  for (const listings of Object.values(db)) {
    for (const listing of listings ?? []) {
      if (listing?.id !== listingId) continue;
      listing.price = newPrice;
      if (newHash != null) listing.id = newHash;
    }
  }
};

/**
 * Every hash rename that was not a price change, in order.
 *
 * The price probe moves a row's price without knowing its hash, so the next scrape finds the advert
 * under a name the job does not recognise and is then told the price has not moved. The rename is
 * all that happens there, and a test that cares whether the row was left on a stale name asserts on
 * these.
 * @type {{listingId: string, newHash: string}[]}
 */
export const renamedHashes = [];
export const renameListingHash = (listingId, newHash) => {
  if (!listingId || newHash == null || newHash === '') return;
  renamedHashes.push({ listingId, newHash });
  // One field stands in for the row's primary key and its hash here, the same way it does in
  // `applyPriceChange` above.
  for (const listings of Object.values(db)) {
    for (const listing of listings ?? []) {
      if (listing?.id === listingId) listing.id = newHash;
    }
  }
};

/**
 * The stored listings of one job that already carry one of the given links, newest per link.
 *
 * Mirrors the real query's contract: hidden listings stay out, so do the ones the alive-checker
 * declared gone, everything else the job stored is a candidate, and the newest row wins for a
 * link several rows have carried.
 *
 * @param {string} jobId
 * @param {string[]} links
 * @returns {Array<Object>}
 */
export const getKnownListingsByLinkForJob = (jobId, links) => {
  const cleaned = [
    ...new Set((Array.isArray(links) ? links : []).filter((l) => typeof l === 'string' && l.length > 0)),
  ];
  if (!jobId || cleaned.length === 0) return [];
  const newestPerLink = new Map();
  for (const [key, listings] of Object.entries(db)) {
    if (!key.startsWith(`${jobId}|`)) continue;
    for (const listing of listings ?? []) {
      if (listing?.manually_deleted === 1) continue;
      if (listing?.is_active === 0) continue;
      if (typeof listing?.link !== 'string' || !cleaned.includes(listing.link)) continue;
      const existing = newestPerLink.get(listing.link);
      if (existing == null || (listing.created_at ?? 0) > (existing.created_at ?? 0)) {
        newestPerLink.set(listing.link, listing);
      }
    }
  }
  // The real query selects only these columns, so the pipeline must not read anything else off the row.
  return [...newestPerLink.values()].map(({ id, link, price, provider, job_id, created_at }) => ({
    id,
    link,
    price,
    provider,
    job_id,
    created_at,
  }));
};
/**
 * The real one writes what the scam detector finds into each stored row. There is no row behind
 * these mocks, and nothing the pipeline does afterwards reads the signals, so like the benchmark it
 * only has to exist. The detector has tests of its own, against a real database.
 */
export const applyScamSignals = (listings) => {
  // noop
};
/* eslint-enable no-unused-vars */
