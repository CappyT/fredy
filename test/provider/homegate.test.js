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
import logger from '../../lib/services/logger.js';

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
        address: { street: 'Badenerstrasse 12', postalCode: '8004', locality: 'Zürich' },
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
        address: { street: 'Langstrasse 45', postalCode: '8004', locality: 'Zürich' },
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

  /**
   * The address field names are the live ones. All 96 listings of a Chiasso search carried
   * `street`, `postalCode`, `locality` and `region`, and not one carried `city`, `zip` or
   * `houseNumber`, so a listing normalized from the invented spelling keeps nothing but the street.
   */
  it('reads the address the live response spells', () => {
    const { normalize } = provider.createConfig(providerConfig.homegate, []);
    const addressOf = (address) =>
      normalize({
        id: 'listing-3',
        listing: {
          id: 'listing-3',
          prices: { rent: { net: 1190 } },
          address,
          localization: { primary: 'de', de: { text: { title: 'Wohnung' } } },
        },
      }).address;

    expect(addressOf({ street: 'Corso San Gottardo 96', postalCode: '6830', locality: 'Chiasso' })).toBe(
      'Corso San Gottardo 96, 6830 Chiasso',
    );
    // Ten of the 96 carried no street. The town is still worth having.
    expect(addressOf({ postalCode: '6830', locality: 'Chiasso' })).toBe('6830 Chiasso');
    // `streetAddition` answered ", Chiasso" live, which is the locality again, so it is left out.
    expect(
      addressOf({ street: 'Via Milano 19', streetAddition: ', Chiasso', postalCode: '6830', locality: 'Chiasso' }),
    ).toBe('Via Milano 19, 6830 Chiasso');
    expect(addressOf({ street: 'Badenerstrasse', houseNumber: '12', zip: '8004', city: 'Zürich' })).toBe(
      'Badenerstrasse',
    );
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
    expect(locationCall).toBe('https://api.re.swissmarketplace.group/geo/locations?lang=en&name=zurich');
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
    expect(asked[0]).toBe('https://api.re.swissmarketplace.group/geo/locations?lang=it&name=chiasso');
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
      'https://api.re.swissmarketplace.group/geo/locations?lang=en&name=zurich',
    );
    expect(bodies[0].body.query).toMatchObject({
      offerType: 'RENT',
      location: { geoTags: ['geo-city-zurich'] },
    });
    // An unmapped word names no type, so the query carries none.
    expect(bodies[0].body.query.propertyType).toBeUndefined();
  });

  it('carries the app user agent, which is the agent of the host it asks', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    await getListings(SEARCH_URL);

    expect(bodies[0].headers['User-Agent']).toBe('homegate.ch.nextgen App Android/13.3.0');
    // The request wears the app's own header set. A 26 digit X-App-Id is what keeps the endpoint
    // on the honest value set.
    expect(bodies[0].headers['X-App-Id']).toMatch(/^\d{26}$/);
    expect(bodies[0].headers['X-App-Version']).toBe('Homegate/13.3.0(13300000)/Android/37');
    expect(bodies[0].headers['X-App-Time']).toBeTruthy();
  });

  it('asks the app host first, and falls back to the portal host when it does not answer', async () => {
    /** @type {string[]} */
    const hosts = [];
    globalThis.fetch = async (url) => {
      const target = String(url);
      hosts.push(target);
      if (target.includes('/geo/locations')) return answer(ZURICH_LOCATIONS);
      if (target.includes('api.re.swissmarketplace.group')) throw new Error('app host down');
      return answer({ results: [{ id: 'l-1', listing: { id: 'l-1', prices: { rent: { net: 1500 } } } }], maxFrom: 0 });
    };
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    const found = await getListings(SEARCH_URL);

    expect(hosts.some((target) => target.includes('api.re.swissmarketplace.group/search/listings'))).toBe(true);
    expect(hosts.some((target) => target.includes('api.homegate.ch/search/listings'))).toBe(true);
    expect(found).toHaveLength(1);
  });

  it('sends the filters, the radius, the sort and the start page the query string names', async () => {
    stubPortal();
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    await getListings(`${SEARCH_URL}?ac=3&o=nr-desc&ah=2000&be=5&ep=2`);

    expect(bodies[0].body).toMatchObject({
      query: {
        offerType: 'RENT',
        numberOfRooms: { from: 3 },
        monthlyRent: { to: 2000 },
        location: { geoTags: ['geo-city-zurich'], radius: 5000 },
      },
      sortBy: 'numberOfRooms',
      sortDirection: 'desc',
      // `ep=2` is the second page, so the walk starts on its offset.
      from: 20,
    });
    // The property type of the path is still sent.
    expect(bodies[0].body.query.propertyType).toBeUndefined();
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
      const results = Array.from({ length: 20 }, (_, index) => {
        const id = `l-${body.from + index}`;
        // A real row keeps its Nettomiete, which is what the poison detector reads as honest.
        return { id, listing: { id, prices: { rent: { net: 1500 } } } };
      });
      return answer({ results, maxFrom });
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
      if (searches.length <= 2) return answer(BLOCK_BODY, 403);
      return answer({ results: [{ id: 'l-1', listing: { id: 'l-1', prices: { rent: { net: 1500 } } } }], maxFrom: 0 });
    };
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    const found = await getListings(SEARCH_URL);

    // The app host is asked first with no cookie; the portal host is the fallback that solves.
    expect(searches).toEqual([null, null, 'datadome=SOLVED']);
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
      filters: { numberOfRooms: { from: 3 }, monthlyRent: { to: 2000 } },
      commercial: false,
      radius: null,
      sort: { sortBy: 'numberOfRooms', sortDirection: 'desc' },
      page: 1,
    });
    expect(provider.parseSearchUrl(SEARCH_URL)).toEqual({
      offerType: 'RENT',
      lang: 'en',
      propertyType: null,
      locationSlug: 'city-zurich',
      filters: {},
      commercial: false,
      radius: null,
      sort: { sortBy: 'dateCreated', sortDirection: 'desc' },
      page: 1,
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
    expect(provider.parseSearchUrl('https://www.homegate.ch/rent/office/city-zurich/matching-list')).toMatchObject({
      offerType: 'RENT',
      lang: 'en',
      propertyType: null,
      locationSlug: 'city-zurich',
    });
    expect(provider.parseSearchUrl('https://www.homegate.ch/buy/commercial/city-zurich/matching-list')).toMatchObject({
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
    expect(provider.parseSearchUrl('https://www.homegate.ch/rent/real-estate')).toMatchObject({
      offerType: 'RENT',
      lang: 'en',
      propertyType: null,
      locationSlug: null,
    });
  });
});

describe('the filters a Homegate query string names', () => {
  /** The English rent path every case below hangs its query string on. */
  const RENT_URL = 'https://www.homegate.ch/rent/real-estate/city-zurich/matching-list';

  /**
   * @param {string} query the query string, `?` included
   * @returns {any} the parsed search
   */
  const rent = (query) => provider.parseSearchUrl(`${RENT_URL}${query}`);

  /**
   * @param {string} query the query string, `?` included
   * @returns {Object} the filters the search carries
   */
  const filters = (query) => rent(query).filters;

  it('turns the real Italian URL into rooms, rent and sort, and drops the map view', () => {
    const searched = provider.parseSearchUrl(REAL_CHIASSO_URL);

    expect(searched.filters).toEqual({ numberOfRooms: { from: 3 }, monthlyRent: { to: 2000 } });
    expect(searched.sort).toEqual({ sortBy: 'numberOfRooms', sortDirection: 'desc' });
    // `view=map` selects the presentation, so it names no query field at all.
    expect(searched.filters.view).toBeUndefined();
    expect(searched.filters.livingSpace).toBeUndefined();
  });

  it('reads the room pair', () => {
    expect(filters('?ac=3')).toEqual({ numberOfRooms: { from: 3 } });
    expect(filters('?ad=3')).toEqual({ numberOfRooms: { to: 3 } });
    expect(filters('?ac=2.5&ad=4.5')).toEqual({ numberOfRooms: { from: 2.5, to: 4.5 } });
  });

  it('reads the rent price pair, and the magnitude suffix the page writes', () => {
    expect(filters('?ag=1000&ah=2000')).toEqual({ monthlyRent: { from: 1000, to: 2000 } });
    expect(filters('?ah=2t')).toEqual({ monthlyRent: { to: 2000 } });
  });

  it('reads the buy price pair on a buy search', () => {
    const buy = provider.parseSearchUrl('https://www.homegate.ch/buy/real-estate/city-zurich?ai=800000&aj=1000000');

    expect(buy.filters).toEqual({ purchasePrice: { from: 800000, to: 1000000 } });
  });

  it('drops the buy price pair on a rent search, and the rent pair on a buy search', () => {
    expect(filters('?ai=800000&aj=1000000')).toEqual({});
    expect(
      provider.parseSearchUrl('https://www.homegate.ch/buy/real-estate/city-zurich?ag=1000&ah=2000').filters,
    ).toEqual({});
  });

  it('reads the remaining size and year pairs', () => {
    expect(filters('?ak=70&al=80')).toEqual({ livingSpace: { from: 70, to: 80 } });
    expect(filters('?ay=200&az=500')).toEqual({ lotSize: { from: 200, to: 500 } });
    expect(filters('?bc=100&bd=200')).toEqual({ cubage: { from: 100, to: 200 } });
    expect(filters('?bf=1990&bg=2010')).toEqual({ yearBuilt: { from: 1990, to: 2010 } });
    expect(filters('?jd=200&jz=400')).toEqual({ yearlyRentPerSqm: { from: 200, to: 400 } });
  });

  it('reads the usable floor space as one field for a home', () => {
    expect(filters('?ba=100&bb=200')).toEqual({ totalFloorSpace: { from: 100, to: 200 } });
  });

  it('splits the usable floor space across two fields for a commercial category', () => {
    expect(rent('?aa=rentoffice&ba=100&bb=200').filters).toEqual({
      totalFloorSpace: { from: 100 },
      singleFloorSpace: { to: 200 },
    });
  });

  it('reads the floor, the published-price flag and the radius', () => {
    expect(filters('?ax=eg')).toEqual({ floor: { from: 0, to: 0.5 } });
    expect(filters('?ax=1')).toEqual({ floor: { from: 0, to: 0.5 } });
    expect(filters('?ax=noteg')).toEqual({ floor: { from: 1 } });
    expect(filters('?ax=2')).toEqual({ floor: { from: 1 } });
    expect(filters('?ipd=true')).toEqual({ isPriceDefined: true });
    // The radius is metres on the wire, kilometres below 1000 in the URL.
    expect(rent('?be=5').radius).toBe(5000);
    expect(rent('?be=3000').radius).toBe(3000);
    expect(rent('?be=abc').radius).toBeNull();
  });

  it('reads the result page as the page the walk starts on', () => {
    expect(rent('?ep=3').page).toBe(3);
    expect(rent('?ep=abc').page).toBe(1);
    expect(rent('').page).toBe(1);
  });

  it('reads the sort parameter in both directions and for every usable key', () => {
    expect(rent('?o=nr-desc').sort).toEqual({ sortBy: 'numberOfRooms', sortDirection: 'desc' });
    expect(rent('?o=nr-asc').sort).toEqual({ sortBy: 'numberOfRooms', sortDirection: 'asc' });
    expect(rent('?o=datecreated-desc').sort).toEqual({ sortBy: 'dateCreated', sortDirection: 'desc' });
    expect(rent('?o=place-asc').sort).toEqual({ sortBy: 'place', sortDirection: 'asc' });
    expect(rent('?o=exclusive-desc').sort).toEqual({ sortBy: 'exclusive', sortDirection: 'desc' });
    expect(rent('?o=sorttoplisting-desc').sort).toEqual({ sortBy: 'listingType', sortDirection: 'desc' });
    // The price sort names a different field by offer type.
    expect(rent('?o=resultingsearchableprice-asc').sort).toEqual({ sortBy: 'monthlyRent', sortDirection: 'asc' });
    expect(
      provider.parseSearchUrl('https://www.homegate.ch/buy/real-estate/city-zurich?o=resultingsearchableprice-asc')
        .sort,
    ).toEqual({ sortBy: 'purchasePrice', sortDirection: 'asc' });
    // `relevance` earns HTTP 500 from the server, and an unknown key names no sort.
    expect(rent('?o=relevance-desc').sort).toEqual({ sortBy: 'dateCreated', sortDirection: 'desc' });
    expect(rent('?o=nonsense').sort).toEqual({ sortBy: 'dateCreated', sortDirection: 'desc' });
  });

  it('lets the category override the offer type the path named', () => {
    const searched = provider.parseSearchUrl(
      'https://www.homegate.ch/affittare/appartamento/luogo-chiasso/lista-annunci?aa=purchflat&ai=800000',
    );

    expect(searched.offerType).toBe('BUY');
    // The price pair follows the offer type the category set, so the buy pair is the one read.
    expect(searched.filters).toEqual({ purchasePrice: { from: 800000 } });
  });

  it('leaves a parameter it cannot read untranslated rather than guessing a field', () => {
    // The page names `aw` as `objectTypes`, but the endpoint ignored that field.
    expect(filters('?aw=APPT,1')).toEqual({});
    // Named in the page's bundle or its robots.txt, never confirmed by a controlled search.
    expect(filters('?an=1&tt=30&sem=pool&loc=123')).toEqual({});
    // A value that does not parse changes nothing.
    expect(filters('?ac=abc&ah=xyz')).toEqual({});
  });

  it('keeps `view` out of the query, whatever value it carries', () => {
    expect(filters('?view=map')).toEqual({});
    expect(filters('?view=list')).toEqual({});
  });
});

describe('the poisoned answers the search endpoint serves', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * The same listing id in its two value sets: the honest copy keeps the Nettomiete, the poisoned
   * copy has it removed. The title and description are rewritten to match either set, so they are
   * not asserted here.
   */
  const HONEST_ROW = {
    id: '4003474009',
    listing: {
      id: '4003474009',
      offerType: 'rent',
      prices: { currency: 'CHF', rent: { net: 990, gross: 990 }, buy: null },
      characteristics: { numberOfRooms: 3, livingSpace: 70 },
      address: { street: 'Via Pier Francesco Mola 3', postalCode: '6830', locality: 'Chiasso' },
      localization: { primary: 'de', de: { text: { title: '3-Zimmer-Wohnung' } } },
    },
  };
  const POISONED_ROW = {
    id: '4003474009',
    listing: {
      id: '4003474009',
      offerType: 'rent',
      prices: { currency: 'CHF', rent: { gross: 1220 }, buy: null },
      characteristics: { numberOfRooms: 1, livingSpace: 20 },
      address: { street: 'Via Pier Francesco Mola 3', postalCode: '6830', locality: 'Chiasso' },
      localization: { primary: 'de', de: { text: { title: '1-Zimmer-Wohnung' } } },
    },
  };

  /**
   * Answer the location lookup and then the search with the given pages, one per request.
   *
   * @param {any[]} pages the pages to answer, the last one repeated once the list runs out
   * @returns {{searches: any[]}} the search requests, in order
   */
  function stubPortal(pages) {
    const searches = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/geo/locations')) return answer(ZURICH_LOCATIONS);
      searches.push(init);
      return answer(pages[Math.min(searches.length - 1, pages.length - 1)]);
    };
    return { searches };
  }

  it('retries past a poisoned page and stores the honest copy of the listing', async () => {
    const { searches } = stubPortal([
      { results: [POISONED_ROW], maxFrom: 0 },
      { results: [HONEST_ROW], maxFrom: 0 },
    ]);
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { getListings, normalize } = provider.createConfig(providerConfig.homegate, []);

    const listings = await getListings(SEARCH_URL);

    // Two requests for the one page: the poisoned answer, then the honest one.
    expect(searches).toHaveLength(2);
    expect(listings).toHaveLength(1);
    const listing = normalize(listings[0]);
    expect(listing.rooms).toBe(3);
    expect(listing.size).toBe(70);
    expect(listing.price).toBe(990);
    // The poisoned page was never stored, so nothing had to be reported as dropped.
    expect(spy).not.toHaveBeenCalled();
  });

  /** A purchase row: it carries no rent price, so the net-price signal cannot read it. */
  const BUY_ROW = {
    id: '1000000000',
    listing: {
      id: '1000000000',
      offerType: 'buy',
      prices: { currency: 'CHF', rent: null, buy: { price: 890000 } },
      characteristics: { numberOfRooms: 4.5, livingSpace: 120 },
      address: { street: 'Bahnhofstrasse 1', postalCode: '8001', locality: 'Zuerich' },
      localization: { primary: 'de', de: { text: { title: '4.5-Zimmer-Wohnung' } } },
    },
  };

  /** The portal's own country-wide purchase search: no numeric filter, so no signal to judge it. */
  const BUY_URL = 'https://www.homegate.ch/buy/real-estate/city-zurich/matching-list';

  it('keeps the rows of a purchase page no signal can judge, and says so once', async () => {
    const { searches } = stubPortal([{ results: [BUY_ROW], maxFrom: 0 }]);
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    const listings = await getListings(BUY_URL);

    expect(listings).toHaveLength(1);
    // The same request would answer the same unknown, so the page is asked for once.
    expect(searches).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0][0]).toContain('could not be verified');
  });

  it('returns no row and logs one line when the page stays poisoned', async () => {
    const { searches } = stubPortal([{ results: [POISONED_ROW], maxFrom: 0 }]);
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { getListings } = provider.createConfig(providerConfig.homegate, []);

    const listings = await getListings(SEARCH_URL);

    expect(listings).toEqual([]);
    // The read gives up at the cap rather than hammering the endpoint without bound.
    expect(searches).toHaveLength(7);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('stayed poisoned');
    expect(spy.mock.calls[0][0]).toContain(SEARCH_URL);
  });
});
