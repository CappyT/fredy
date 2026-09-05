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
export const getKnownListingHashesForJob = (jobKey) => {
  return Object.entries(db)
    .filter(([key]) => key.startsWith(`${jobKey}|`))
    .flatMap(([, listings]) => listings)
    .map((listing) => listing?.id)
    .filter((id) => id != null);
};

/**
 * Forget every stored listing.
 *
 * The dedup the real store performs is memory across runs, which a test that runs the same
 * listing twice under one job does not want carried from the previous case.
 * @returns {void}
 */
export const resetListings = () => {
  for (const key of Object.keys(db)) delete db[key];
  recordedPriceObservations.length = 0;
  appliedPriceChanges.length = 0;
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
 * @type {{listingId: string, newPrice: number}[]}
 */
export const appliedPriceChanges = [];
export const applyPriceChange = (listingId, newPrice, changedAt = Date.now()) => {
  appliedPriceChanges.push({ listingId, newPrice, changedAt });
};

/**
 * The stored listings of one job that already carry one of the given links, newest per link.
 *
 * Mirrors the real query's contract: hidden listings stay out, everything else the job stored is
 * a candidate, and the newest row wins for a link several rows have carried.
 *
 * @param {string} jobId
 * @param {string[]} links
 * @returns {Array<Object>}
 */
export const getKnownListingsByLinkForJob = (jobId, links) => {
  const cleaned = [...new Set((Array.isArray(links) ? links : []).filter((l) => typeof l === 'string' && l.length > 0))];
  if (!jobId || cleaned.length === 0) return [];
  const newestPerLink = new Map();
  for (const [key, listings] of Object.entries(db)) {
    if (!key.startsWith(`${jobId}|`)) continue;
    for (const listing of listings ?? []) {
      if (listing?.manually_deleted === 1) continue;
      if (typeof listing?.link !== 'string' || !cleaned.includes(listing.link)) continue;
      const existing = newestPerLink.get(listing.link);
      if (existing == null || (listing.created_at ?? 0) > (existing.created_at ?? 0)) {
        newestPerLink.set(listing.link, listing);
      }
    }
  }
  return [...newestPerLink.values()];
};
/* eslint-enable no-unused-vars */
