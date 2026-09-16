/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/homegate.js';
import { tokenForBlock } from '../../lib/services/datadome.js';

/**
 * Homegate, the Swiss portal read through its mobile API.
 *
 * The search endpoint is behind DataDome and the pasted URL cannot be handed to it as it is, so
 * three things have to hold and are asserted one at a time here: the URL becomes the right
 * structured query, the location slug is resolved through the open location endpoint, and a
 * refusal is handed to the solver once rather than for every page.
 *
 * `tokenForBlock` is replaced: a solve costs money and reaches capsolver, so what is pinned is that
 * the provider asks for one and sends what it answers, not that capsolver works.
 */
vi.mock('../../lib/services/datadome.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, tokenForBlock: vi.fn(async () => 'datadome=SOLVED') };
});

const TEST_TIMEOUT = 120_000;
const SEARCH_URL = providerConfig.homegate.url;

/** The real Italian search URL the provider failed to read, kept as a regression case. */
const REAL_CHIASSO_URL =
  'https://www.homegate.ch/affittare/appartamento/luogo-chiasso/lista-annunci?ac=3&o=nr-desc&ah=2000&view=map';

/** The recorded live answer to `name=chiasso`. The shape is the endpoint's own, nested as served. */
const CHIASSO_LOCATIONS = JSON.parse(
  readFileSync(new URL('../testFixtures/homegate_locations_chiasso.json', import.meta.url), 'utf-8'),
);

/**
 * A live `/geo/locations` answer for Zurich, in the nested shape the endpoint really uses.
 *
 * The `urlNames` block is what identifies the place: the slug the search URL wrote has to appear
 * in it, in one of the four languages.
 */
const ZURICH_LOCATIONS = {
  from: 0,
  size: 1,
  total: 67,
  results: [
    {
      geoLocation: {
        id: 'geo-city-zurich',
        urlNames: { de: 'ort-zuerich', en: 'city-zurich', fr: 'lieu-zurich', it: 'luogo-zurigo' },
      },
    },
  ],
};

/** The challenge the live endpoint answers an unsolved request with. */
const BLOCK_BODY = JSON.stringify({
  url: 'https://geo.captcha-delivery.com/captcha/?initialCid=x&hash=F366DD7CF4DB76FA9B54F971FAB24F&t=fe&s=1',
});

const answer = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 403 ? 'Forbidden' : 'OK',
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

describe('#homegate provider testsuite()', () => {
  /** @type {any[]} */
  let listings;

  beforeAll(async () => {
    const Fredy = await mockFredy();
    const runConfig = provider.createConfig(providerConfig.homegate, [], []);
    const job = { id: 'homegate', notificationAdapter: null, spatialFilter: null, specFilter: null };

    const fredy = new Fredy(runConfig, job, provider.metaInformation.id, similarityCache, undefined);
    listings = await fredy.execute();
  }, TEST_TIMEOUT);

  it('resolves the location, gets through the search and finds listings', () => {
    expect(listings).toBeInstanceOf(Array);
    expect(listings.length).toBeGreaterThan(0);
  });

  it('reads the API decimals as decimals, not as thousands separators', () => {
    const withRooms = listings.filter((listing) => listing.rooms != null);
    expect(withRooms.length).toBeGreaterThan(0);

    for (const listing of withRooms) {
      expect(listing.rooms, `rooms of ${listing.id}`).toBeGreaterThan(0);
      expect(listing.rooms, `rooms of ${listing.id}`).toBeLessThan(30);
    }
  });

  it('carries a price, an address and a link on every listing', () => {
    for (const listing of listings) {
      expect(typeof listing.price, `price of ${listing.id}`).toBe('number');
      expect(listing.price, `price of ${listing.id}`).toBeGreaterThan(0);
      expect(listing.address, `address of ${listing.id}`).toBeTruthy();
      expect(listing.link, `link of ${listing.id}`).toMatch(/^https:\/\/www\.homegate\.ch\/(rent|buy)\/\d+$/);
    }
  });

  it('declares Switzerland, which is what sends the geocoder there and prices the listings in francs', () => {
    expect(provider.metaInformation.countries).toEqual(['ch']);
  });

  /**
   * The precedence the Flatfox provider documents, for the same affordability reason: `gross` is
   * the Bruttomiete and the check adds a Nebenkosten surcharge to whatever stands here. Driven
   * through `normalize` with a synthetic payload, because the normalized listing no longer carries
   * the raw rent fields the comparison needs.
   */
  it('quotes the Nettomiete, then the gross figure, then the buy price', () => {
    const { normalize } = provider.createConfig(providerConfig.homegate, []);
    const base = {
      id: 'listing-1',
      listing: {
        id: 'listing-1',
        offerType: 'rent',
        characteristics: { livingSpace: 82, numberOfRooms: 3.5 },
        address: { street: 'Badenerstrasse', houseNumber: '12', zip: '8004', city: 'Zürich' },
        localization: { primary: 'de', de: { text: { title: 'Wohnung' } } },
      },
    };
    const withPrices = (prices) => normalize({ ...base, listing: { ...base.listing, prices } });

    expect(withPrices({ rent: { net: 2550, gross: 2790 }, buy: { price: 1250000 } }).price, 'the Nettomiete wins').toBe(
      2550,
    );
    expect(withPrices({ rent: { net: null, gross: 2790 }, buy: { price: 1250000 } }).price, 'then the gross rent').toBe(
      2790,
    );
    expect(withPrices({ rent: null, buy: { price: 1250000 } }).price, 'then the buy price').toBe(1250000);
  });

  it('labels the listing title, the size, the rooms and the publication date', () => {
    const { normalize } = provider.createConfig(providerConfig.homegate, []);
    const listing = normalize({
      id: 'listing-2',
      listing: {
        id: 'listing-2',
        offerType: 'rent',
        prices: { rent: { net: 2100 } },
        characteristics: { livingSpace: 82.5, numberOfRooms: 3.5 },
        address: { street: 'Langstrasse', houseNumber: '45', zip: '8004', city: 'Zürich' },
        meta: { createdAt: '2026-09-10T08:00:00Z' },
        localization: { primary: 'de', de: { text: { title: 'Helle 3.5-Zimmer-Wohnung' } } },
      },
    });

    expect(listing.title).toBe('Helle 3.5-Zimmer-Wohnung');
    expect(listing.size).toBe(82.5);
    expect(listing.rooms).toBe(3.5);
    expect(listing.address).toBe('Langstrasse 45, 8004 Zürich');
    expect(listing.publishedAt).toBe(Date.parse('2026-09-10T08:00:00Z'));
  });
});

describe('the search a pasted URL translates to', () => {
  /** @type {any} */
  let originalFetch;
  /** @type {string[]} */
  let asked;
  /** @type {any[]} */
  let bodies;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    asked = [];
    bodies = [];
    tokenForBlock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * @param {any[]} pages what the search endpoint answers, one entry per request
   * @returns {void}
   */
  function stubPortal(pages = [{ results: [], maxFrom: 0 }]) {
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      asked.push(target);
      if (target.includes('/geo/locations')) return answer(ZURICH_LOCATIONS);
      bodies.push({ headers: init?.headers, body: JSON.parse(init?.body) });
      return answer(pages[Math.min(bodies.length - 1, pages.length - 1)]);
    };
  }

  it('asks the location endpoint for the slug and no cookie, and searches the tag it answers', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    await getListings(SEARCH_URL);

    const locationCall = asked.find((target) => target.includes('/geo/locations'));
    // `rent` is the English offer type word, so the lookup is made in English.
    expect(locationCall).toBe('https://api.homegate.ch/geo/locations?lang=en&name=zurich');
    expect(bodies[0].headers.Cookie).toBeUndefined();

    expect(bodies[0].body).toMatchObject({
      query: { offerType: 'RENT', location: { geoTags: ['geo-city-zurich'] } },
      sortBy: 'dateCreated',
      sortDirection: 'desc',
      from: 0,
      size: 20,
      fieldset: 'srp-list',
    });
    // `real-estate` names no type, so the query carries none.
    expect(bodies[0].body.query.propertyType).toBeUndefined();
  });

  it('reads the real Italian URL, trailing result page segment and all', async () => {
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      asked.push(target);
      if (target.includes('/geo/locations')) return answer(CHIASSO_LOCATIONS);
      bodies.push({ headers: init?.headers, body: JSON.parse(init?.body) });
      return answer({ results: [], maxFrom: 0 });
    };
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    await getListings(REAL_CHIASSO_URL);

    // The Italian offer type word asks in Italian, and the slug is the place, not the trailing
    // `lista-annunci` segment.
    expect(asked[0]).toBe('https://api.homegate.ch/geo/locations?lang=it&name=chiasso');
    expect(bodies[0].body.query).toMatchObject({
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: { geoTags: ['geo-city-chiasso'] },
    });
  });

  it('reads the offer type and the category off the URL', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    await getListings('https://www.homegate.ch/buy/house/city-zurich?ep=1');

    expect(bodies[0].body.query).toMatchObject({
      offerType: 'BUY',
      propertyType: 'HOUSE_OR_CHALET_OR_RUSTICO',
      location: { geoTags: ['geo-city-zurich'] },
    });
  });

  it('reads a place that stands behind a property word it does not map', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    // `office` is not in the property type map, so the place is the segment behind it.
    await getListings('https://www.homegate.ch/rent/office/city-zurich/matching-list');

    expect(asked.find((target) => target.includes('/geo/locations'))).toBe(
      'https://api.homegate.ch/geo/locations?lang=en&name=zurich',
    );
    expect(bodies[0].body.query).toMatchObject({
      offerType: 'RENT',
      location: { geoTags: ['geo-city-zurich'] },
    });
    // An unmapped word names no type, so the query carries none.
    expect(bodies[0].body.query.propertyType).toBeUndefined();
  });

  it('carries the app user agent, which is the one DataDome answers with a solvable challenge', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    await getListings(SEARCH_URL);

    expect(bodies[0].headers['User-Agent']).toBe('homegate.ch.nextgen App Android/13.3.0');
  });

  it('answers nothing for a URL it cannot read, rather than searching the wrong thing', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);
    const listingCount = bodies.length;

    expect(await getListings('https://www.immobilienscout24.de/Suche/de/berlin')).toEqual([]);
    expect(await getListings('https://www.homegate.ch/rent/real-estate-listings')).toEqual([]);
    expect(await getListings('not a url')).toEqual([]);
    expect(bodies).toHaveLength(listingCount);
  });

  it('answers nothing when the location endpoint knows no such place', async () => {
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      return answer({
        from: 0,
        size: 1,
        total: 1,
        results: [{ geoLocation: { id: 'geo-city-lugano', urlNames: { en: 'city-lugano' } } }],
      });
    };
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    expect(await getListings(SEARCH_URL)).toEqual([]);
    // The place the URL named did not resolve, so the search is never made. Running it without the
    // place would answer the whole country for a job that asked for one town.
    expect(asked.some((target) => target.includes('/search/listings'))).toBe(false);
  });

  it('searches the whole country, and asks no location, for a URL that names no place', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    await getListings('https://www.homegate.ch/rent/apartment');

    expect(asked.some((target) => target.includes('/geo/locations'))).toBe(false);
    expect(bodies[0].body.query).toEqual({ offerType: 'RENT', propertyType: 'APARTMENT' });
  });
});

describe('the pages a search walks', () => {
  /** @type {any} */
  let originalFetch;
  /** @type {number[]} */
  let froms;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    froms = [];
    tokenForBlock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * @param {number} maxFrom the ceiling the endpoint reports
   * @returns {void}
   */
  function stubPortal(maxFrom) {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/geo/locations')) return answer(ZURICH_LOCATIONS);
      const body = JSON.parse(init.body);
      froms.push(body.from);
      return answer({ results: Array.from({ length: 20 }, (_, index) => ({ id: `l-${body.from + index}` })), maxFrom });
    };
  }

  it('stops at the ceiling the endpoint names', async () => {
    stubPortal(40);
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    const found = await getListings(SEARCH_URL);

    expect(froms).toEqual([0, 20, 40]);
    expect(found).toHaveLength(60);
  });

  it('stops at the page cap even when the endpoint offers more', async () => {
    stubPortal(500);
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    const found = await getListings(SEARCH_URL);

    expect(froms).toEqual([0, 20, 40, 60, 80]);
    expect(found).toHaveLength(100);
  });
});

describe('a DataDome refusal', () => {
  /** @type {any} */
  let originalFetch;
  /** @type {any[]} */
  let searches;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    searches = [];
    tokenForBlock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('is handed to the solver once, and the retry carries the cookie it answers', async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/geo/locations')) return answer(ZURICH_LOCATIONS);
      searches.push(init?.headers?.Cookie ?? null);
      if (searches.length === 1) return answer(BLOCK_BODY, 403);
      return answer({ results: [{ id: 'l-1', listing: { id: 'l-1' } }], maxFrom: 0 });
    };
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    const found = await getListings(SEARCH_URL);

    expect(searches).toEqual([null, 'datadome=SOLVED']);
    expect(found).toHaveLength(1);
    expect(tokenForBlock).toHaveBeenCalledTimes(1);
    expect(tokenForBlock.mock.calls[0][0]).toMatchObject({ status: 403, host: 'api.homegate.ch' });
  });

  it('stays a failed read when no cookie can be got', async () => {
    tokenForBlock.mockResolvedValueOnce(null);
    globalThis.fetch = async (url) => {
      if (String(url).includes('/geo/locations')) return answer(ZURICH_LOCATIONS);
      return answer(BLOCK_BODY, 403);
    };
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    expect(await getListings(SEARCH_URL)).toEqual([]);
  });
});

describe('the search a Homegate path spells', () => {
  it('reads the two real search URLs', () => {
    expect(provider.parseSearchUrl(REAL_CHIASSO_URL)).toEqual({
      offerType: 'RENT',
      lang: 'it',
      propertyType: 'APARTMENT',
      locationSlug: 'luogo-chiasso',
    });
    expect(provider.parseSearchUrl(SEARCH_URL)).toEqual({
      offerType: 'RENT',
      lang: 'en',
      propertyType: null,
      locationSlug: 'city-zurich',
    });
  });

  it('reads the offer type, and its language, in all four languages', () => {
    expect(provider.parseSearchUrl('https://www.homegate.ch/mieten/wohnung/ort-zuerich')).toMatchObject({
      offerType: 'RENT',
      lang: 'de',
      propertyType: 'APARTMENT',
      locationSlug: 'ort-zuerich',
    });
    expect(provider.parseSearchUrl('https://www.homegate.ch/louer/appartement/lieu-zurich')).toMatchObject({
      offerType: 'RENT',
      lang: 'fr',
      propertyType: 'APARTMENT',
      locationSlug: 'lieu-zurich',
    });
    expect(provider.parseSearchUrl('https://www.homegate.ch/affittare/appartamento/luogo-chiasso')).toMatchObject({
      offerType: 'RENT',
      lang: 'it',
      propertyType: 'APARTMENT',
      locationSlug: 'luogo-chiasso',
    });
    expect(provider.parseSearchUrl('https://www.homegate.ch/buy/house/city-zurich')).toMatchObject({
      offerType: 'BUY',
      lang: 'en',
      propertyType: 'HOUSE_OR_CHALET_OR_RUSTICO',
      locationSlug: 'city-zurich',
    });
  });

  it('ignores the trailing result page segment, in all four languages', () => {
    for (const srp of ['matching-list', 'trefferliste', 'liste-annonces', 'lista-annunci']) {
      expect(provider.parseSearchUrl(`https://www.homegate.ch/rent/apartment/city-zurich/${srp}`).locationSlug).toBe(
        'city-zurich',
      );
    }
  });

  it('reads the place that follows a property word it does not map', () => {
    // Both are real links on Homegate's own result page. `office` and `commercial` name no type this
    // maps, so the place is the last leftover segment, behind them.
    expect(provider.parseSearchUrl('https://www.homegate.ch/rent/office/city-zurich/matching-list')).toEqual({
      offerType: 'RENT',
      lang: 'en',
      propertyType: null,
      locationSlug: 'city-zurich',
    });
    expect(provider.parseSearchUrl('https://www.homegate.ch/buy/commercial/city-zurich/matching-list')).toEqual({
      offerType: 'BUY',
      lang: 'en',
      propertyType: null,
      locationSlug: 'city-zurich',
    });
  });

  it('leaves the property type absent for an "everything" category', () => {
    for (const category of ['real-estate', 'immobilien', 'biens-immobiliers', 'immobile']) {
      const search = provider.parseSearchUrl(`https://www.homegate.ch/rent/${category}/city-zurich`);
      expect(search.propertyType, category).toBeNull();
      expect(search.locationSlug).toBe('city-zurich');
    }
  });

  it('answers null for a URL it cannot read', () => {
    expect(provider.parseSearchUrl('not a url')).toBeNull();
    // No offer type this knows, on another portal's host.
    expect(provider.parseSearchUrl('https://www.immobilienscout24.de/Suche/de/berlin')).toBeNull();
  });

  it('reads a path that names no place as the country-wide search the portal publishes', () => {
    // The portal's own sitemap carries this form, so it states a search rather than a broken URL.
    expect(provider.parseSearchUrl('https://www.homegate.ch/rent/real-estate')).toEqual({
      offerType: 'RENT',
      lang: 'en',
      propertyType: null,
      locationSlug: null,
    });
  });
});
