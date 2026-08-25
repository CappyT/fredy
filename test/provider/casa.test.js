/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/casa.js';

/**
 * Casa.it, one of the three national portals Italian agencies publish to.
 *
 * The results are read out of `window.__INITIAL_STATE__` rather than out of the markup, so what
 * these tests pin is the shape of that store. The store arrives escaped twice - a JSON document
 * inside a JavaScript string literal - which is the part most likely to be got wrong.
 *
 * Assertions are structural rather than literal, because the same file runs against the fixture
 * (`yarn test:offline`) and against the live portal (`yarn test`), where every advert differs.
 */
const TEST_TIMEOUT = 120_000;

describe('#casa provider testsuite()', () => {
  /** @type {any[]} */
  let listings;

  beforeAll(async () => {
    const Fredy = await mockFredy();
    const runConfig = provider.createConfig(providerConfig.casa, [], []);
    const job = { id: 'casa', notificationAdapter: null, spatialFilter: null, specFilter: null };

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

  /**
   * The store carries the price twice, as a number on the map marker and as "1.900" on the card.
   * Read as a decimal, that card figure is one euro ninety.
   */
  it('reads the headline figures as numbers', () => {
    for (const listing of carrying('price')) {
      expect(typeof listing.price, `price of ${listing.id}`).toBe('number');
      // Ten is the guard against "1.900" read as a decimal, which would arrive as one euro ninety.
      expect(listing.price, `price of ${listing.id}`).toBeGreaterThan(10);
    }
    for (const listing of carrying('size')) {
      expect(listing.size, `size of ${listing.id}`).toBeGreaterThan(0);
    }
    for (const listing of carrying('rooms')) {
      expect(listing.rooms, `rooms of ${listing.id}`).toBeGreaterThan(0);
      expect(listing.rooms, `rooms of ${listing.id}`).toBeLessThan(30);
    }
  });

  it('builds an absolute link out of the relative path the store holds', () => {
    for (const listing of listings) {
      expect(listing.link, `link of ${listing.id}`).toMatch(/^https:\/\/www\.casa\.it\/immobili\//);
    }
  });

  it('names the town alongside the street', () => {
    for (const listing of carrying('address')) {
      expect(listing.address, `address of ${listing.id}`).toContain(',');
    }
  });

  it('brings the coordinates with it', () => {
    for (const listing of carrying('latitude')) {
      // Italy's mainland box, which is what the map allows for an Italian provider.
      expect(listing.latitude, `latitude of ${listing.id}`).toBeGreaterThan(35);
      expect(listing.latitude, `latitude of ${listing.id}`).toBeLessThan(48);
      expect(listing.longitude, `longitude of ${listing.id}`).toBeGreaterThan(6);
      expect(listing.longitude, `longitude of ${listing.id}`).toBeLessThan(19);
    }
  });

  it('serves the photo off the image host rather than as a bare path', () => {
    for (const listing of carrying('image')) {
      expect(listing.image, `image of ${listing.id}`).toMatch(/^https:\/\/images-1\.casa\.it\//);
    }
  });

  /** Anything casa.it does not recognise falls back to relevance without saying so. */
  it('sorts by the criterion casa.it actually knows', () => {
    expect(provider.config.sortByDateParam).toBe('sortType=date_desc');
  });

  it('declares Italy, which is what sends the geocoder there', () => {
    expect(provider.metaInformation.countries).toEqual(['it']);
  });
});
