/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import * as mockStore from '../mocks/mockStore.js';
import { mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/immoscout24ch.js';
import { clearTokens } from '../../lib/services/datadome.js';
import logger from '../../lib/services/logger.js';

/**
 * ImmoScout24.ch, the second Swiss provider Fredy ships.
 *
 * It reads a JSON API like flatfox, but behind two extra steps: the pasted URL has to be turned
 * into the structured query the search endpoint wants, and its place has to be resolved through the
 * location autocomplete before the search can run. The endpoint also sits behind DataDome, so the
 * cookie the solver earns is part of the read.
 *
 * The listing fixture is synthetic: it is built from the response model in
 * `reverse-engineered-homegate.md` with this portal's own values, not recorded from the live API.
 * The location fixture is a real recording of `GET /geo/locations`, nested shape and all.
 *
 * Assertions are structural, because the same file runs against the fixture (`yarn test:offline`)
 * and against the live API (`yarn test`).
 */
const TEST_TIMEOUT = 120_000;

const SEARCH_URL = providerConfig.immoscout24ch.url;

/** The real Italian search URL the provider failed to read, kept as a regression case. */
const REAL_CHIASSO_URL =
  'https://www.immoscout24.ch/it/appartamento/affittare/luogo-chiasso?slf=80&nrf=3&an=8000&pt=2000';

/** The recorded live answer to `name=chiasso`. The shape is the endpoint's own, nested as served. */
const CHIASSO_LOCATIONS = JSON.parse(
  readFileSync(new URL('../testFixtures/immoscout24ch_locations_chiasso.json', import.meta.url), 'utf-8'),
);

/** The locations the autocomplete answers for `Zuerich`, in the nested shape it really uses. */
const LOCATIONS = {
  from: 0,
  size: 2,
  total: 2,
  results: [
    {
      geoLocation: {
        id: 'geo-canton-zurich',
        urlNames: { de: 'kanton-zuerich', en: 'canton-zurich', fr: 'canton-zurich', it: 'cantone-zurigo' },
      },
    },
    {
      geoLocation: {
        id: 'geo-city-zurich',
        urlNames: { de: 'ort-zuerich', en: 'city-zurich', fr: 'lieu-zurich', it: 'luogo-zurigo' },
      },
    },
  ],
};

const LIST_FIXTURE = JSON.parse(
  readFileSync(new URL('../testFixtures/immoscout24ch_listings.json', import.meta.url), 'utf-8'),
);

/** A DataDome refusal, in the JSON shape the two Swiss portals answer one. */
const DATADOME_CHALLENGE = {
  url: 'https://geo.captcha-delivery.com/captcha/?initialCid=AHrl&cid=CID&hash=F366DD7CF4DB76FA9B54F971FAB24F&t=fe&s=52458&e=81046c',
};

/** @param {any} body @param {number} [status] @returns {any} a response-shaped object */
function answer(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Replace the global `fetch` with a router, recording every call it sees.
 *
 * @param {(call: {url: string, init: any}, count: number) => any} handler
 * @returns {{url: string, init: any}[]} the calls, in order
 */
function stubFetch(handler) {
  const calls = [];
  vi.stubGlobal('fetch', async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length);
  });
  return calls;
}

describe('#immoscout24ch provider testsuite()', () => {
  /** @type {any[]} */
  let listings;

  beforeAll(async () => {
    const Fredy = await mockFredy();
    const runConfig = provider.createConfig(providerConfig.immoscout24ch, []);
    const job = { id: 'immoscout24ch', notificationAdapter: null, spatialFilter: null, specFilter: null };

    const fredy = new Fredy(runConfig, job, provider.metaInformation.id, similarityCache, undefined);
    listings = await fredy.execute();
  }, TEST_TIMEOUT);

  it('gets through the location lookup and the search and finds listings', () => {
    expect(listings).toBeInstanceOf(Array);
    expect(listings.length).toBeGreaterThan(0);
  });

  it('maps every required field on every listing', () => {
    for (const listing of listings) {
      for (const field of provider.config.requiredFieldNames) {
        expect(listing[field], `${field} of ${listing.id}`).toBeTruthy();
      }
    }
  });

  it('reads the API decimals as decimals, not as thousands separators', () => {
    const withRooms = listings.filter((listing) => listing.rooms != null);
    expect(withRooms.length).toBeGreaterThan(0);

    for (const listing of withRooms) {
      expect(listing.rooms, `rooms of ${listing.id}`).toBeGreaterThan(0);
      expect(listing.rooms, `rooms of ${listing.id}`).toBeLessThan(30);
    }
  });

  it('takes the coordinates the response published and skips the geocoder', () => {
    for (const listing of listings) {
      expect(typeof listing.latitude, `latitude of ${listing.id}`).toBe('number');
      expect(typeof listing.longitude, `longitude of ${listing.id}`).toBe('number');
    }
    // The pipeline geocodes per listing when the listing is not located yet. Every fixture listing
    // carries coordinates, so a lookup here would be a lookup the response made unnecessary.
    expect(mockStore.geocodedAddresses).toEqual([]);
  });

  it('links to the German listing page', () => {
    for (const listing of listings) {
      expect(listing.link, `link of ${listing.id}`).toMatch(/^https:\/\/www\.immoscout24\.ch\/de\/d\/\d+$/);
    }
  });

  it('declares Switzerland, which is what sends the geocoder there and writes the prices in francs', () => {
    expect(provider.metaInformation.countries).toEqual(['ch']);
    for (const listing of listings) {
      expect(listing.currency, `currency of ${listing.id}`).toBe('CHF');
    }
  });

  /**
   * The rent precedence, driven through `normalize` with synthetic payloads rather than asserted on
   * `listings`, because the normalized listing no longer carries the raw price fields.
   */
  it('quotes the Nettomiete, falls back to the gross figure, and to the purchase price', () => {
    const { normalize } = provider.createConfig(providerConfig.immoscout24ch, []);
    const base = {
      id: '1',
      address: { street: 'Seefeldstrasse 12', postalCode: '8008', locality: 'Zürich' },
      characteristics: { livingSpace: 92, numberOfRooms: 3.5 },
      meta: { createdAt: '2026-09-10T08:15:00Z' },
    };

    expect(normalize({ ...base, prices: { rent: { net: 1850, gross: 2050 } } }).price).toBe(1850);
    expect(normalize({ ...base, prices: { rent: { net: null, gross: 2050 } } }).price).toBe(2050);
    expect(normalize({ ...base, prices: { rent: null, buy: { price: 1250000 } } }).price).toBe(1250000);
  });

  it('reads the title, the photograph and the publication date of the fixture listing', () => {
    const { normalize } = provider.createConfig(providerConfig.immoscout24ch, []);
    const listing = normalize(LIST_FIXTURE.results[0].listing);

    // `localization.primary` selects the block, so the German title wins over the English one.
    expect(listing.title).toBe('3.5-Zimmer-Wohnung mit Balkon am Seefeld');
    // The plan comes first in the attachments and is skipped: only the image url is taken.
    expect(listing.image).toBe('https://media.immoscout24.ch/4001234567/living-room.jpg');
    expect(listing.publishedAt).toBe(Date.UTC(2026, 8, 10, 8, 15, 0));
    expect(listing.address).toBe('Seefeldstrasse 12, 8008 Zürich');
  });

  /**
   * The address model is the live one, and it is the model Homegate answers too: `street` already
   * carries the house number, the town is `postalCode` plus `locality`, and `city`, `zip` and
   * `streetNumber` do not exist in the response.
   */
  it('reads the address the live response spells', () => {
    const { normalize } = provider.createConfig(providerConfig.immoscout24ch, []);
    const addressOf = (address) => normalize({ id: '1', address, prices: { rent: { net: 1200 } } }).address;

    expect(addressOf({ street: 'Corso San Gottardo 24', postalCode: '6830', locality: 'Chiasso' })).toBe(
      'Corso San Gottardo 24, 6830 Chiasso',
    );
    expect(addressOf({ postalCode: '6830', locality: 'Chiasso' })).toBe('6830 Chiasso');
    expect(addressOf({ street: 'Seefeldstrasse', streetNumber: '12', zip: '8008', city: 'Zürich' })).toBe(
      'Seefeldstrasse',
    );
  });

  it('rejects a listing whose title is blacklisted', () => {
    const { filter } = provider.createConfig(providerConfig.immoscout24ch, ['Balkon']);
    expect(filter({ id: '1', title: 'Wohnung mit Balkon', description: 'x' })).toBe(false);
    expect(filter({ id: '1', title: 'Wohnung ohne', description: 'x' })).toBe(true);
  });
});

describe('translating the pasted search URL', () => {
  it('reads the two real search URLs', () => {
    expect(provider.parseSearchUrl(REAL_CHIASSO_URL)).toEqual({
      lang: 'it',
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: 'luogo-chiasso',
    });
    expect(provider.parseSearchUrl(SEARCH_URL)).toEqual({
      lang: 'de',
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: 'ort-zuerich',
    });
  });

  it('reads the offer type, the property type and the place, in all four languages', () => {
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/wohnung/mieten/ort-zuerich')).toEqual({
      lang: 'de',
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: 'ort-zuerich',
    });
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/fr/appartement/louer/lieu-zurich')).toEqual({
      lang: 'fr',
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: 'lieu-zurich',
    });
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/it/casa/acquistare/luogo-chiasso')).toEqual({
      lang: 'it',
      offerType: 'BUY',
      propertyType: 'HOUSE_OR_CHALET_OR_RUSTICO',
      location: 'luogo-chiasso',
    });
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/en/apartment/rent/city-zurich')).toEqual({
      lang: 'en',
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: 'city-zurich',
    });
  });

  it('keeps a hyphen that is part of the place name', () => {
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten/zuerich-seefeld').location).toBe(
      'zuerich-seefeld',
    );
  });

  it('ignores the trailing result page segment, in all four languages', () => {
    for (const srp of ['matching-list', 'trefferliste', 'liste-annonces', 'lista-annunci']) {
      expect(provider.parseSearchUrl(`https://www.immoscout24.ch/de/wohnung/mieten/ort-zuerich/${srp}`).location).toBe(
        'ort-zuerich',
      );
    }
  });

  it('reads a URL that ends in the result page segment as the country-wide search', () => {
    // A real agency URL: the trailing Italian result page segment names no place, so the path names
    // none and the search covers the whole country.
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/it/immobili/affittare/lista-annunci')).toEqual({
      lang: 'it',
      offerType: 'RENT',
      propertyType: null,
      location: null,
    });
  });

  it('reads the place that follows a property word it does not map', () => {
    // A real drilldown URL: `buero` names no type this maps, so the place is the segment behind it.
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten/buero/ort-zuerich')).toEqual({
      lang: 'de',
      offerType: 'RENT',
      propertyType: null,
      location: 'ort-zuerich',
    });
  });

  it('leaves the property type absent for an "everything" category', () => {
    for (const category of ['real-estate', 'immobilien', 'immobilier', 'immobili']) {
      const search = provider.parseSearchUrl(`https://www.immoscout24.ch/de/${category}/mieten/ort-zuerich`);
      expect(search.propertyType, category).toBeNull();
      expect(search.location).toBe('ort-zuerich');
    }
  });

  it('reads the language off the offer type word when the path carries no prefix', () => {
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/immobilien/affittare/luogo-chiasso')).toEqual({
      lang: 'it',
      offerType: 'RENT',
      propertyType: null,
      location: 'luogo-chiasso',
    });
  });

  it('leaves the place out when the path names none, and rejects a URL it cannot parse', () => {
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten').location).toBeNull();
    expect(provider.parseSearchUrl('not a url')).toBeNull();
  });
});

describe('translating the query string of a pasted search URL', () => {
  /**
   * The filters a query string asks for, on the real Italian search URL. The path is the same one
   * for every case, so the only thing that changes is the filter under test.
   *
   * @param {string} queryString the query string, leading `?` included
   */
  const filtersOf = (queryString) =>
    provider.parseSearchFilters(`https://www.immoscout24.ch/it/appartamento/affittare/luogo-chiasso${queryString}`);

  it('reads the real filter URL into the query the search endpoint wants', () => {
    expect(provider.parseSearchFilters(REAL_CHIASSO_URL)).toEqual({
      query: {
        livingSpace: { from: 80 },
        numberOfRooms: { from: 3 },
        monthlyRent: { to: 2000 },
        hasParkingOrGarage: true,
      },
      radius: null,
      sortBy: null,
      sortDirection: null,
      page: null,
    });
  });

  it('reads the living space, the lot size and the floor space bounds in the spelling the server honours', () => {
    expect(filtersOf('?slf=80&slt=150').query).toEqual({ livingSpace: { from: 80, to: 150 } });
    expect(filtersOf('?spf=200&spt=800').query).toEqual({ lotSize: { from: 200, to: 800 } });
    expect(filtersOf('?suf=50&sut=120').query).toEqual({ totalFloorSpace: { from: 50, to: 120 } });
  });

  it('reads the room bounds and keeps the half a room count can carry', () => {
    expect(filtersOf('?nrf=3&nrt=4.5').query).toEqual({ numberOfRooms: { from: 3, to: 4.5 } });
  });

  it('sends the one price pair to the field the offer type names', () => {
    expect(filtersOf('?pf=1000&pt=2000').query).toEqual({ monthlyRent: { from: 1000, to: 2000 } });

    const buy = provider.parseSearchFilters(
      'https://www.immoscout24.ch/it/casa/acquistare/luogo-chiasso?pf=300000&pt=900000',
    );
    expect(buy.query).toEqual({ purchasePrice: { from: 300000, to: 900000 } });
  });

  it('scales a price by the unit letter the client accepts', () => {
    // `t` is a thousand and `m` a million; a price without a letter stays francs.
    expect(filtersOf('?pt=2t').query).toEqual({ monthlyRent: { to: 2000 } });
    expect(filtersOf('?pf=1m').query).toEqual({ monthlyRent: { from: 1000000 } });
    expect(filtersOf('?pt=2000').query).toEqual({ monthlyRent: { to: 2000 } });
  });

  it('drops the price pair rather than guess its target when the URL names no offer type', () => {
    expect(provider.parseSearchFilters('https://www.immoscout24.ch/it/immobili/luogo-chiasso?pt=2000').query).toEqual(
      {},
    );
  });

  it('reads the radius as kilometres under a thousand and as metres above', () => {
    expect(filtersOf('?r=5').radius).toBe(5000);
    expect(filtersOf('?r=1200').radius).toBe(1200);
    expect(filtersOf('').radius).toBeNull();
  });

  it('reads the comma-separated object type codes into API categories', () => {
    expect(filtersOf('?pty=1,21').query).toEqual({ categories: ['APARTMENT', 'ROOF_FLAT'] });
    expect(filtersOf('?pty=24').query).toEqual({ categories: ['MAISONETTE', 'DUPLEX'] });
    expect(filtersOf('?pty=26').query).toEqual({ categories: ['BUNGALOW', 'SINGLE_HOUSE', 'ENGADINE_HOUSE'] });
    // The client folds FURNISHED_FLAT onto APARTMENT, which would widen the search to every
    // apartment. The API has the exact category, and it narrows.
    expect(filtersOf('?pty=62').query).toEqual({ categories: ['FURNISHED_FLAT'] });
  });

  it('ignores an object type code the document does not name', () => {
    expect(filtersOf('?pty=2,999').query).toEqual({});
    expect(filtersOf('?pty=2,1').query).toEqual({ categories: ['APARTMENT'] });
  });

  it('decodes the an bitmask, five bits per character, read right to left', () => {
    // The three values the document decodes with the client's own decoder.
    expect(filtersOf('?an=8000').query).toEqual({ hasParkingOrGarage: true });
    expect(filtersOf('?an=4000').query).toEqual({ isChildFriendly: true });
    expect(filtersOf('?an=1').query).toEqual({ isWheelchairAccessible: true });
    // Bit 4 is the last bit the rightmost character carries.
    expect(filtersOf('?an=G').query).toEqual({ isNewBuilding: true });
    // Two characters: the left one carries bits 5 to 9, so `8` there is bit 8.
    expect(filtersOf('?an=8G').query).toEqual({ hasElevator: true, isNewBuilding: true });
  });

  it('ignores the bits of the an mask that the document does not name', () => {
    // `V` holds 31, so all five bits of the rightmost character. Bits 2 and 3 name no facility.
    expect(filtersOf('?an=V').query).toEqual({
      isWheelchairAccessible: true,
      arePetsAllowed: true,
      isNewBuilding: true,
    });
  });

  it('drops an an value it cannot read rather than half read it', () => {
    expect(filtersOf('?an=!!!').query).toEqual({});
    expect(filtersOf('?an=8000!').query).toEqual({});
  });

  it('reads the sort the URL names, and defaults the direction to desc', () => {
    expect(filtersOf('?o=nr-asc')).toMatchObject({ sortBy: 'numberOfRooms', sortDirection: 'asc' });
    expect(filtersOf('?o=nr')).toMatchObject({ sortBy: 'numberOfRooms', sortDirection: 'desc' });
    expect(filtersOf('?o=resultingsearchableprice-asc')).toMatchObject({
      sortBy: 'monthlyRent',
      sortDirection: 'asc',
    });
    expect(
      provider.parseSearchFilters(
        'https://www.immoscout24.ch/it/casa/acquistare/luogo-chiasso?o=resultingsearchableprice-asc',
      ).sortBy,
    ).toBe('purchasePrice');
  });

  it('ignores a sort name the API does not accept, so the provider keeps its own', () => {
    expect(filtersOf('?o=nonsense-asc')).toMatchObject({ sortBy: null, sortDirection: null });
  });

  it('reads the page number as the start of the walk', () => {
    expect(filtersOf('?pn=3').page).toBe(3);
    // The first page is where the walk starts anyway, so it asks for nothing.
    expect(filtersOf('?pn=1').page).toBeNull();
  });

  it('ignores a parameter it does not know, rather than guess a filter from it', () => {
    // `nrs` sets the page size, which the endpoint rejects as an unsupported value, and `rr`,
    // `view` and a made-up name are not filters at all.
    expect(filtersOf('?nrs=50&rr=1&view=map&unheard=7')).toMatchObject({
      query: {},
      radius: null,
      sortBy: null,
      sortDirection: null,
      page: null,
    });
  });

  it('reads a malformed bound as absent rather than as zero', () => {
    expect(filtersOf('?slf=abc&nrf=three&pt=none&spf=').query).toEqual({});
  });
});

describe('the structured search it runs', () => {
  it('resolves the place through the geo endpoint and asks for the newest first', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('/geo/locations') ? answer(LOCATIONS) : answer({ results: [], maxFrom: 0 }),
    );

    const runConfig = provider.createConfig({ url: SEARCH_URL }, []);
    await runConfig.getListings(runConfig.url);

    const geo = new URL(calls[0].url);
    expect(geo.pathname).toBe('/geo/locations');
    expect(geo.searchParams.get('name')).toBe('zuerich');
    expect(geo.searchParams.get('lang')).toBe('de');

    // The entry whose `urlNames` spell the URL's own slug is the place: `ort-zuerich` picks the
    // city out of the two answers, not the canton that shares its name.
    const search = JSON.parse(calls[1].init.body);
    expect(search.query).toEqual({
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: { geoTags: ['geo-city-zurich'] },
    });
    expect(search.sortBy).toBe('dateCreated');
    expect(search.sortDirection).toBe('desc');
    expect(search.fieldset).toBe('srp-list');
    expect(search.size).toBe(20);
    expect(search.from).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('resolves the real Italian URL to the city it names', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('/geo/locations') ? answer(CHIASSO_LOCATIONS) : answer({ results: [], maxFrom: 0 }),
    );

    const runConfig = provider.createConfig({ url: REAL_CHIASSO_URL }, []);
    await runConfig.getListings(runConfig.url);

    // The Italian offer type word asks in Italian, and the place is `chiasso`, not the kind prefix.
    const geo = new URL(calls[0].url);
    expect(geo.searchParams.get('name')).toBe('chiasso');
    expect(geo.searchParams.get('lang')).toBe('it');

    const search = JSON.parse(calls[1].init.body);
    // The URL's filters reach the search: living space from 80, rooms from 3, rent to 2000, and
    // the parking facility the `an=8000` bit asks for.
    expect(search.query).toEqual({
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: { geoTags: ['geo-city-chiasso'] },
      livingSpace: { from: 80 },
      numberOfRooms: { from: 3 },
      monthlyRent: { to: 2000 },
      hasParkingOrGarage: true,
    });
  });

  it('carries the app user agent, which is the agent of the host it asks', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('/geo/locations') ? answer(LOCATIONS) : answer({ results: [], maxFrom: 0 }),
    );

    const runConfig = provider.createConfig({ url: SEARCH_URL }, []);
    await runConfig.getListings(runConfig.url);

    const search = calls.find((call) => call.url.includes('/search/listings'));
    expect(search.init.headers['User-Agent']).toBe('immoscout24.ch.nextgen App Android/6.3.0');
  });

  it('carries a non-empty X-App-Id on every search, which is what keeps the answer honest', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('/geo/locations') ? answer(LOCATIONS) : answer({ results: [], maxFrom: 0 }),
    );

    const runConfig = provider.createConfig({ url: SEARCH_URL }, []);
    await runConfig.getListings(runConfig.url);

    const search = calls.find((call) => call.url.includes('/search/listings'));
    expect(search.init.headers['X-App-Id']).toMatch(/^\d{26}$/);
    expect(search.init.headers['X-App-Version']).toBe('Immoscout24/6.3.0(6300000)/Android/37');
    expect(search.init.headers['X-App-Time']).toBeTruthy();
  });

  it('fails the read when the place resolves nothing, rather than searching the whole country', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('/geo/locations')
        ? answer({
            from: 0,
            size: 1,
            total: 1,
            results: [{ geoLocation: { id: 'geo-city-lugano', urlNames: { it: 'luogo-lugano' } } }],
          })
        : answer({ results: [], maxFrom: 0 }),
    );

    const runConfig = provider.createConfig({ url: REAL_CHIASSO_URL }, []);
    await expect(runConfig.getListings(runConfig.url)).resolves.toEqual([]);

    // The search endpoint was never asked: a place that does not resolve fails the read.
    expect(calls.filter((call) => call.url.includes('/search/listings'))).toHaveLength(0);
  });

  it('asks the search for the sort and the first page the URL names', async () => {
    const bodies = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      const body = JSON.parse(call.init.body);
      bodies.push(body);
      return answer({ results: [], maxFrom: 0 });
    });

    const url = 'https://www.immoscout24.ch/de/wohnung/mieten/ort-zuerich?o=nr-asc&pn=3';
    await provider.createConfig({ url }, []).getListings(url);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].sortBy).toBe('numberOfRooms');
    expect(bodies[0].sortDirection).toBe('asc');
    // `pn=3` is the third page of twenty, so the walk starts at forty.
    expect(bodies[0].from).toBe(40);
  });

  it('carries the radius next to the place, and drops it for a URL that names no place', async () => {
    const bodies = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      bodies.push(JSON.parse(call.init.body));
      return answer({ results: [], maxFrom: 0 });
    });

    const withPlace = 'https://www.immoscout24.ch/de/wohnung/mieten/ort-zuerich?r=5';
    await provider.createConfig({ url: withPlace }, []).getListings(withPlace);
    expect(bodies[0].query.location).toEqual({ geoTags: ['geo-city-zurich'], radius: 5000 });

    const withoutPlace = 'https://www.immoscout24.ch/it/appartamento/affittare?r=5';
    await provider.createConfig({ url: withoutPlace }, []).getListings(withoutPlace);
    expect(bodies[1].query.location).toBeUndefined();
  });

  it('stops the walk once `from` would pass maxFrom', async () => {
    const froms = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      const body = JSON.parse(call.init.body);
      froms.push(body.from);
      return answer({
        results: [{ id: `p${body.from}`, listing: { id: `p${body.from}`, prices: { rent: { net: 1500 } } } }],
        maxFrom: 20,
      });
    });

    const runConfig = provider.createConfig({ url: SEARCH_URL }, []);
    await runConfig.getListings(runConfig.url);

    expect(froms).toEqual([0, 20]);
  });

  it('stops the walk at the page cap when the search reports no ceiling', async () => {
    const froms = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      const body = JSON.parse(call.init.body);
      froms.push(body.from);
      const results = Array.from({ length: 20 }, (_, index) => ({
        id: `p${body.from}-${index}`,
        // A real row keeps its Nettomiete, which is what the poison detector reads as honest.
        listing: { id: 'x', prices: { rent: { net: 1500 } } },
      }));
      return answer({ results, maxFrom: body.from + 20 });
    });

    const runConfig = provider.createConfig({ url: SEARCH_URL }, []);
    const found = await runConfig.getListings(runConfig.url);

    expect(froms).toEqual([0, 20, 40, 60, 80]);
    expect(found).toHaveLength(100);
  });

  it('reads no listing when the URL names no offer type, rather than searching everything', async () => {
    const calls = stubFetch(() => answer(LOCATIONS));

    const runConfig = provider.createConfig({ url: 'https://www.immoscout24.ch/de/immobilien/ort-zuerich' }, []);
    await expect(runConfig.getListings(runConfig.url)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('searches the whole country, and asks no location, for a URL that names no place', async () => {
    // The portal publishes this form in its own drilldown sitemap, so it states a country-wide
    // search rather than a URL that failed to parse.
    const calls = stubFetch(() => answer({ results: [], maxFrom: 0 }));

    const runConfig = provider.createConfig({ url: 'https://www.immoscout24.ch/it/appartamento/affittare' }, []);
    await runConfig.getListings(runConfig.url);

    expect(calls.filter((call) => call.url.includes('/geo/locations'))).toHaveLength(0);
    expect(JSON.parse(calls[0].init.body).query).toEqual({ offerType: 'RENT', propertyType: 'APARTMENT' });
  });
});

describe('a search the endpoint refuses', () => {
  let storeDir;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'immoscout24ch-datadome-'));
    process.env.FREDY_DATADOME_STORE = join(storeDir, 'datadome-tokens.json');
    clearTokens();
  });

  afterEach(() => {
    clearTokens();
    delete process.env.FREDY_DATADOME_STORE;
    delete process.env.CAPSOLVER_API_KEY;
    delete process.env.FREDY_PROXY_URL;
    rmSync(storeDir, { recursive: true, force: true });
  });

  /**
   * The refusal has to reach the solver as the DataDome block it is, and the retry has to carry the
   * cookie it earned. The solver is the real module, so what is stubbed is the capsolver exchange
   * and the proxy the deployment would have configured.
   */
  it('retries the search once with the cookie capsolver minted', async () => {
    process.env.CAPSOLVER_API_KEY = 'offline-key';
    process.env.FREDY_PROXY_URL = 'http://user:pass@proxy.example:8080';

    const searches = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      if (call.url.endsWith('/createTask')) return answer({ errorId: 0, taskId: 'task-1' });
      if (call.url.endsWith('/getTaskResult')) {
        return answer({ errorId: 0, status: 'ready', solution: { cookie: 'datadome=solved; Max-Age=31536000' } });
      }

      searches.push(call);
      const cookie = call.init.headers?.Cookie;
      if (cookie == null && searches.length === 1) return answer(DATADOME_CHALLENGE, 403);
      return answer({ results: [], maxFrom: 0 });
    });

    const runConfig = provider.createConfig({ url: SEARCH_URL }, []);
    await runConfig.getListings(runConfig.url);

    expect(searches).toHaveLength(2);
    expect(searches[0].init.headers.Cookie).toBeUndefined();
    // The header rides on the retry too: the request that carries the cookie is the one the server
    // must see as the app, or the answer it serves stays rewritten.
    expect(searches[0].init.headers['X-App-Id']).toMatch(/^\d{26}$/);
    expect(searches[1].init.headers['X-App-Id']).toMatch(/^\d{26}$/);
    expect(searches[1].init.headers.Cookie).toBe('datadome=solved');
  });

  it('fails the read when the deployment cannot solve, rather than searching without a cookie', async () => {
    const searches = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      searches.push(call);
      return answer(DATADOME_CHALLENGE, 403);
    });

    const runConfig = provider.createConfig({ url: SEARCH_URL }, []);
    await expect(runConfig.getListings(runConfig.url)).resolves.toEqual([]);

    // Asked once and not repeated: a refused read is a failed read, it is not paid for per page.
    expect(searches).toHaveLength(1);
    expect(searches[0].init.headers.Cookie).toBeUndefined();
  });
});

describe('the poisoned answers the search endpoint serves', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * The same listing id in its two value sets: the honest copy keeps the Nettomiete, the poisoned
   * copy has it removed. The free text is rewritten to match either set, so it is not asserted.
   */
  const HONEST_ROW = {
    id: '4003474009',
    offerType: 'rent',
    prices: { currency: 'CHF', rent: { net: 990, gross: 990 }, buy: null },
    characteristics: { numberOfRooms: 3, livingSpace: 70 },
    address: { street: 'Via Pier Francesco Mola 3', postalCode: '6830', locality: 'Chiasso' },
    localization: { primary: 'de', de: { text: { title: '3-Zimmer-Wohnung' } } },
  };
  const POISONED_ROW = {
    id: '4003474009',
    offerType: 'rent',
    prices: { currency: 'CHF', rent: { gross: 1220 }, buy: null },
    characteristics: { numberOfRooms: 1, livingSpace: 20 },
    address: { street: 'Via Pier Francesco Mola 3', postalCode: '6830', locality: 'Chiasso' },
    localization: { primary: 'de', de: { text: { title: '1-Zimmer-Wohnung' } } },
  };

  /**
   * Answer the location lookup and then the search with the given pages, one per request.
   *
   * @param {any[]} pages the pages to answer, the last one repeated once the list runs out
   * @returns {{searches: any[]}} the search requests, in order
   */
  function stubPortal(pages) {
    const searches = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      searches.push(call);
      return answer(pages[Math.min(searches.length - 1, pages.length - 1)]);
    });
    return { searches };
  }

  it('retries past a poisoned page and stores the honest copy of the listing', async () => {
    const { searches } = stubPortal([
      { results: [{ id: POISONED_ROW.id, listing: POISONED_ROW }], maxFrom: 0 },
      { results: [{ id: HONEST_ROW.id, listing: HONEST_ROW }], maxFrom: 0 },
    ]);
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { getListings, normalize } = provider.createConfig(providerConfig.immoscout24ch, []);

    const listings = await getListings(SEARCH_URL);

    expect(searches).toHaveLength(2);
    expect(listings).toHaveLength(1);
    const listing = normalize(listings[0]);
    expect(listing.rooms).toBe(3);
    expect(listing.size).toBe(70);
    expect(listing.price).toBe(990);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns no row and logs one line when the page stays poisoned', async () => {
    const { searches } = stubPortal([{ results: [{ id: POISONED_ROW.id, listing: POISONED_ROW }], maxFrom: 0 }]);
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { getListings } = provider.createConfig(providerConfig.immoscout24ch, []);

    const listings = await getListings(SEARCH_URL);

    expect(listings).toEqual([]);
    expect(searches).toHaveLength(7);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('stayed poisoned');
    expect(spy.mock.calls[0][0]).toContain(SEARCH_URL);
  });
});
