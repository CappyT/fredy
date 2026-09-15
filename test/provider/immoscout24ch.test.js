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

/**
 * ImmoScout24.ch, the second Swiss provider Fredy ships.
 *
 * It reads a JSON API like flatfox, but behind two extra steps: the pasted URL has to be turned
 * into the structured query the search endpoint wants, and its place has to be resolved through the
 * location autocomplete before the search can run. The endpoint also sits behind DataDome, so the
 * cookie the solver earns is part of the read.
 *
 * The fixture is synthetic: it is built from the response model in `reverse-engineered-homegate.md`
 * with this portal's own values, not recorded from the live API.
 *
 * Assertions are structural, because the same file runs against the fixture (`yarn test:offline`)
 * and against the live API (`yarn test`).
 */
const TEST_TIMEOUT = 120_000;

const SEARCH_URL = providerConfig.immoscout24ch.url;

const LIST_FIXTURE = JSON.parse(
  readFileSync(new URL('../testFixtures/immoscout24ch_listings.json', import.meta.url), 'utf-8'),
);

/** The locations the autocomplete answers for one name. The canton is first on purpose. */
const LOCATIONS = [
  { id: 'geo-canton-zurich', name: 'Kanton Zürich', type: 'CANTON' },
  { id: 'geo-city-zurich', name: 'Zürich', type: 'CITY' },
  { id: 'geo-zipcode-8001', name: '8001 Zürich', type: 'ZIPCODE' },
];

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
      address: { street: 'Seefeldstrasse', streetNumber: '12', zip: '8008', city: 'Zürich' },
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

  it('rejects a listing whose title is blacklisted', () => {
    const { filter } = provider.createConfig(providerConfig.immoscout24ch, ['Balkon']);
    expect(filter({ id: '1', title: 'Wohnung mit Balkon', description: 'x' })).toBe(false);
    expect(filter({ id: '1', title: 'Wohnung ohne', description: 'x' })).toBe(true);
  });
});

describe('translating the pasted search URL', () => {
  it('reads the offer type, the property type and the place, in all four languages', () => {
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten/wohnung/ort-zuerich')).toEqual({
      lang: 'de',
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: { name: 'zuerich', kindTag: 'geo-city-' },
    });
    expect(
      provider.parseSearchUrl('https://www.immoscout24.ch/fr/immobilier/louer/appartement/ort-zurich'),
    ).toMatchObject({ lang: 'fr', offerType: 'RENT', propertyType: 'APARTMENT' });
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/it/immobili/vendita/casa/ort-zurigo')).toMatchObject({
      lang: 'it',
      offerType: 'BUY',
      propertyType: 'HOUSE_OR_CHALET_OR_RUSTICO',
    });
    expect(
      provider.parseSearchUrl('https://www.immoscout24.ch/en/real-estate/rent/apartment/ort-zurich'),
    ).toMatchObject({
      lang: 'en',
      offerType: 'RENT',
      propertyType: 'APARTMENT',
    });
  });

  it('reads the kind of place the slug names without eating a hyphen inside a name', () => {
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten/kanton-zuerich').location).toEqual({
      name: 'zuerich',
      kindTag: 'geo-canton-',
    });
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten/plz-8001').location).toEqual({
      name: '8001',
      kindTag: 'geo-zipcode-',
    });
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten/zuerich-seefeld').location).toEqual(
      {
        name: 'zuerich-seefeld',
        kindTag: null,
      },
    );
  });

  it('leaves the place out when the path names none, and rejects a URL it cannot parse', () => {
    expect(provider.parseSearchUrl('https://www.immoscout24.ch/de/immobilien/mieten').location).toBeNull();
    expect(provider.parseSearchUrl('not a url')).toBeNull();
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

    // The kind the slug named is what picks the city out of the three answers.
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

  it('stops the walk once `from` would pass maxFrom', async () => {
    const froms = [];
    stubFetch((call) => {
      if (call.url.includes('/geo/locations')) return answer(LOCATIONS);
      const body = JSON.parse(call.init.body);
      froms.push(body.from);
      return answer({ results: [{ id: `p${body.from}`, listing: { id: `p${body.from}` } }], maxFrom: 20 });
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
        listing: { id: 'x' },
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
