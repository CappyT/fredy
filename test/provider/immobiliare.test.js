/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/immobiliare.js';

/**
 * Immobiliare.it, Italy's largest property portal and the first provider Fredy ships for Italy.
 *
 * The results are read out of the search page's `__NEXT_DATA__` rather than out of its markup, so
 * what these tests pin is the shape of that payload: a renamed class name is harmless, a renamed
 * field is not.
 *
 * Assertions are structural rather than literal, because the same file runs against the fixture
 * (`yarn test:offline`) and against the live portal (`yarn test`), where every advert differs.
 */
const TEST_TIMEOUT = 120_000;

describe('#immobiliare provider testsuite()', () => {
  /** @type {any[]} */
  let listings;

  beforeAll(async () => {
    const Fredy = await mockFredy();
    const runConfig = provider.createConfig(providerConfig.immobiliare, [], []);
    const job = { id: 'immobiliare', notificationAdapter: null, spatialFilter: null, specFilter: null };

    const fredy = new Fredy(runConfig, job, provider.metaInformation.id, similarityCache, undefined);
    listings = await fredy.execute();
  }, TEST_TIMEOUT);

  /**
   * Every portal carries adverts that leave a figure out - a price on request, a garage with no
   * rooms - and a live run will meet one sooner or later. What is pinned is that the figures that
   * are there are readable, not that every advert has them all.
   *
   * @param {string} field
   * @returns {any[]} the listings carrying that field
   */
  const carrying = (field) => {
    const found = listings.filter((listing) => listing[field] != null);
    expect(found.length, `no listing carried a ${field}`).toBeGreaterThan(0);
    return found;
  };

  it('finds listings', () => {
    expect(listings).toBeInstanceOf(Array);
    expect(listings.length).toBeGreaterThan(0);
  });

  it('reads the headline figures as numbers', () => {
    for (const listing of carrying('price')) {
      expect(typeof listing.price, `price of ${listing.id}`).toBe('number');
      expect(listing.price, `price of ${listing.id}`).toBeGreaterThan(0);
    }
    for (const listing of carrying('size')) {
      expect(listing.size, `size of ${listing.id}`).toBeGreaterThan(0);
    }
    for (const listing of carrying('rooms')) {
      expect(listing.rooms, `rooms of ${listing.id}`).toBeGreaterThan(0);
      // A flat with more rooms than this is the open "5+" band read as something else entirely.
      expect(listing.rooms, `rooms of ${listing.id}`).toBeLessThan(30);
    }
  });

  it('links to the advert rather than to a relative path', () => {
    for (const listing of listings) {
      expect(listing.link, `link of ${listing.id}`).toMatch(/^https:\/\/www\.immobiliare\.it\/annunci\//);
    }
  });

  /**
   * The reason the provider builds the address at all. The payload keeps the street and the town in
   * two separate fields, and "Via Giulia" on its own is a street in half the country.
   */
  it('names the town alongside the street', () => {
    for (const listing of carrying('address')) {
      expect(listing.address, `address of ${listing.id}`).toContain(',');
    }
  });

  /**
   * The adverts carry their own coordinates, which is what keeps the pipeline from spending a
   * Nominatim request per listing to arrive at a worse answer.
   */
  it('brings the coordinates with it', () => {
    for (const listing of carrying('latitude')) {
      // Italy's mainland box, which is what the map allows for an Italian provider.
      expect(listing.latitude, `latitude of ${listing.id}`).toBeGreaterThan(35);
      expect(listing.latitude, `latitude of ${listing.id}`).toBeLessThan(48);
      expect(listing.longitude, `longitude of ${listing.id}`).toBeGreaterThan(6);
      expect(listing.longitude, `longitude of ${listing.id}`).toBeLessThan(19);
    }
  });

  /**
   * `dataModifica` is the criterion the portal sorted by until it stopped honouring it; it is now
   * accepted and ignored, and a search sent with it comes back with the paid placements first.
   */
  it('sorts by the publication date the search backend still honours', () => {
    expect(provider.config.sortByDateParam).toBe('criterio=data&ordine=desc');
  });

  it('declares Italy, which is what sends the geocoder there', () => {
    expect(provider.metaInformation.countries).toEqual(['it']);
  });
});
