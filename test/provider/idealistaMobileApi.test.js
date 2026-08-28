/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  call,
  forgetToken,
  formEncode,
  REQUEST_GAP_MS,
  resetPacing,
  sign,
} from '../../lib/services/idealista/mobile-api.js';
import { readCategory, readFilters } from '../../lib/services/idealista/search-filters.js';
import { translateSearchUrl } from '../../lib/services/idealista/web-translator.js';
import { slugify } from '../../lib/services/idealista/locations.js';
import { decodePolyline, parseOutline, sharedLocationId, simplifyRing } from '../../lib/services/idealista/zones.js';

// The device id is an installation's property and lives in the settings table; in these tests it
// is simply a constant, so no database is ever opened.
vi.mock('../../lib/services/idealista/device-id.js', () => ({
  idealistaDeviceId: async () => '0123456789abcdef',
}));

/**
 * The idealista provider asks the app's api for a search that a user described by pasting a website
 * url. What these tests pin is that translation, because it is where a portal change lands and
 * because nothing else in the pipeline can tell a search that was carried over faithfully from one
 * that quietly widened.
 *
 * `reverse-engineered-idealista.md` records where each of these facts was measured.
 */
describe('the signature idealista wants on every request', () => {
  /**
   * The api rebuilds the signed message from the parameters it received, encoding them as
   * `java.net.URLEncoder` does. `encodeURIComponent` differs from it in exactly these places, and a
   * signature computed over the difference is rejected with a 401 that names nothing.
   */
  it('encodes a parameter the way java does, not the way javascript does', () => {
    expect(formEncode('due locali')).toBe('due+locali');
    expect(formEncode("a!b'c(d)e~f")).toBe('a%21b%27c%28d%29e%7Ef');
    // Left alone by both, and so a silent difference if either list were changed.
    expect(formEncode('a*b-c_d.e')).toBe('a*b-c_d.e');
    expect(formEncode('[0-EU-IT-MI]')).toBe('%5B0-EU-IT-MI%5D');
  });

  it('signs with a fresh seed, so two identical requests do not carry one signature', () => {
    const query = /** @type {Array<[string, unknown]>} */ ([['k', 'key']]);
    const first = sign('POST', query, []);
    const second = sign('POST', query, []);

    expect(first.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(first.seed).not.toBe(second.seed);
    expect(first.signature).not.toBe(second.signature);
  });
});

describe('the search a website url describes', () => {
  it('reads the category out of the first segment', () => {
    expect(readCategory('vendita-case')).toEqual({ operation: 'sale', propertyType: 'homes' });
    expect(readCategory('affitto-stanze')).toEqual({ operation: 'rent', propertyType: 'bedrooms' });
    // The api sells no land, so this search has to be read off the website.
    expect(readCategory('vendita-terreni')).toBeNull();
  });

  it('takes the place out of the path and ignores what the query string says', () => {
    const search = translateSearchUrl('https://www.idealista.it/affitto-case/milano-milano/centro-storico/?ordine=x');

    expect(search).toMatchObject({
      operation: 'rent',
      propertyType: 'homes',
      locationSlugs: ['milano-milano', 'centro-storico'],
      locationCodes: [],
    });
  });

  it('reads a url the portal serves in another language, and one naming a page', () => {
    const expected = { operation: 'rent', propertyType: 'homes', locationSlugs: ['roma-roma'] };

    expect(translateSearchUrl('https://www.idealista.it/en/affitto-case/roma-roma/')).toMatchObject(expected);
    expect(translateSearchUrl('https://www.idealista.it/affitto-case/roma-roma/lista-3.htm')).toMatchObject(expected);
  });

  it('reports the codes of a multi-area search rather than trying to name them', () => {
    const search = translateSearchUrl('https://www.idealista.it/multi/vendita-case/a5W,a7j,dJY/');

    expect(search?.locationCodes).toEqual(['a5W', 'a7j', 'dJY']);
    expect(search?.locationSlugs).toEqual([]);
  });

  /**
   * A search drawn on the map names no place: the polygon travels in the query string, as the
   * encoded polyline rings the tile host also serves borders in.
   */
  it('reads a drawn search, whose polygon sits in the query string', () => {
    const drawn =
      'https://www.idealista.it/aree/vendita-case/con-prezzo_300000,aste_no/?shape=%28%28qwnuGijvz%40%7DpH%29%29';

    expect(translateSearchUrl(drawn)).toMatchObject({
      operation: 'sale',
      propertyType: 'homes',
      locationSlugs: [],
      locationCodes: [],
      drawnShape: '((qwnuGijvz@}pH))',
      variants: [
        [
          ['maxPrice', '300000'],
          ['auction', 'excludeAuctions'],
        ],
      ],
    });

    // A drawn search pages without the `.htm` the other searches carry.
    const paged = 'https://www.idealista.it/aree/vendita-case/lista-3?shape=%28%28qwnuGijvz%40%7DpH%29%29';
    expect(translateSearchUrl(paged)?.drawnShape).toBe('((qwnuGijvz@}pH))');
  });

  /**
   * The search that motivated the drawn translation, kept whole: a price ceiling, both energy
   * boxes, no auctions, the "Appartamenti" box and the four house shapes, over two building
   * conditions - eight searches whose answers merge.
   */
  it('carries a drawn search over whole', () => {
    const search = translateSearchUrl(
      'https://www.idealista.it/aree/vendita-case/con-prezzo_300000,appartamenti,case-indipendenti,' +
        'villette-bifamiliari,villette-a-schiera,ville-indipendenti,trilocali-3,quadrilocali-4,' +
        '5-locali-o-piu,nuova-costruzione,buono-stato,aste_no,alta-efficienza,media-efficienza/' +
        '?shape=%28%28qwnuGijvz%40%7DpHyrB%29%29',
    );

    expect(search?.drawnShape).toBe('((qwnuGijvz@}pHyrB))');
    expect(search?.variants).toHaveLength(8);
    for (const variant of search?.variants ?? []) {
      expect(variant).toContainEqual(['maxPrice', '300000']);
      expect(variant).toContainEqual(['bedrooms', '3,4,5']);
      expect(variant).toContainEqual(['auction', 'excludeAuctions']);
      expect(variant).toContainEqual(['energyEfficiency', 'high,medium']);
    }
  });

  /**
   * A url the api cannot be asked for in full is answered with nothing at all, so that the caller
   * reads the website. Answering with the part that did translate would run a wider search than the
   * user asked for and tell them about adverts they filtered out.
   */
  it('gives up on a search it cannot carry over whole', () => {
    // A filter with no counterpart: only a balcony has a parameter.
    expect(translateSearchUrl('https://www.idealista.it/affitto-case/roma-roma/con-terrazza/')).toBeNull();
    // A category the api does not serve.
    expect(translateSearchUrl('https://www.idealista.it/vendita-terreni/roma-roma/')).toBeNull();
    // A drawn search that lost its polygon says nothing about where it looks.
    expect(translateSearchUrl('https://www.idealista.it/aree/vendita-case/')).toBeNull();
    expect(translateSearchUrl('not a url')).toBeNull();
  });
});

describe('the filters a website url hides in its path', () => {
  /**
   * The website's two names read against each other: the price is a ceiling where the size is a
   * floor. Reading either the wrong way round turns a search into its opposite and nothing
   * downstream would notice.
   */
  it('reads the price as a ceiling and the size as a floor', () => {
    expect(readFilters('con-prezzo_450000')).toEqual([[['maxPrice', '450000']]]);
    expect(readFilters('con-prezzo-min_180000')).toEqual([[['minPrice', '180000']]]);
    expect(readFilters('con-dimensione_80')).toEqual([[['minSize', '80']]]);
    expect(readFilters('con-dimensione-max_250')).toEqual([[['maxSize', '250']]]);
  });

  it('stacks the filters the website ticks box by box', () => {
    expect(readFilters('con-trilocali-3,quadrilocali-4,5-locali-o-piu')).toEqual([[['bedrooms', '3,4,5']]]);
    expect(readFilters('con-bagno-1,bagno-2')).toEqual([[['bathrooms', '1,2']]]);
  });

  /**
   * The website lets several building conditions be ticked and means their union; the api takes one
   * and answers a list with a 500. The search is therefore run once per condition.
   */
  it('splits a search naming several building conditions', () => {
    expect(readFilters('con-nuova-costruzione,buono-stato')).toEqual([
      [['preservation', 'newdevelopment']],
      [['preservation', 'good']],
    ]);
  });

  /**
   * Asking for a shape of house is already asking for a house, and the api reads `chalet` alongside
   * `subTypology` as the wider of the two - every house rather than the four that were asked for.
   */
  it('lets the shape of a house speak for itself', () => {
    expect(readFilters('con-villette-a-schiera,ville-indipendenti')).toEqual([
      [['subTypology', 'terracedHouse,villa']],
    ]);
  });

  /**
   * The energy boxes stack into one graded list, which unlike `preservation` the api reads as the
   * union it means.
   */
  it('reads the energy boxes as one list', () => {
    expect(readFilters('con-alta-efficienza,media-efficienza')).toEqual([[['energyEfficiency', 'high,medium']]]);
    expect(readFilters('con-aste_no')).toEqual([[['auction', 'excludeAuctions']]]);
  });

  /**
   * "Appartamenti" covers flats, penthouses and two-level flats together, and the api honours one
   * shape of home per search, so the box becomes one search per shape - alongside the houses' own
   * search where the url names those too, and once per condition like any other split.
   */
  it('runs the "Appartamenti" box once per shape of home', () => {
    expect(readFilters('con-appartamenti')).toEqual([[['flat', '1']], [['penthouse', '1']], [['duplex', '1']]]);

    expect(readFilters('con-appartamenti,ville-indipendenti')).toEqual([
      [['flat', '1']],
      [['penthouse', '1']],
      [['duplex', '1']],
      [['subTypology', 'villa']],
    ]);

    expect(readFilters('con-appartamenti,nuova-costruzione,buono-stato')).toEqual([
      [
        ['flat', '1'],
        ['preservation', 'newdevelopment'],
      ],
      [
        ['flat', '1'],
        ['preservation', 'good'],
      ],
      [
        ['penthouse', '1'],
        ['preservation', 'newdevelopment'],
      ],
      [
        ['penthouse', '1'],
        ['preservation', 'good'],
      ],
      [
        ['duplex', '1'],
        ['preservation', 'newdevelopment'],
      ],
      [
        ['duplex', '1'],
        ['preservation', 'good'],
      ],
    ]);
  });

  it('has nothing to say about a url that carries no filters', () => {
    expect(readFilters('')).toEqual([[]]);
  });

  it('refuses a filter it has no counterpart for', () => {
    expect(readFilters('con-bassa-efficienza')).toBeNull();
    expect(readFilters('con-ascensori,terrazza')).toBeNull();
  });
});

describe('the places a search url names', () => {
  it('spells a name the way the url does', () => {
    expect(slugify('Milano, Milano')).toBe('milano-milano');
    expect(slugify('Centro Storico, Milano')).toBe('centro-storico-milano');
    expect(slugify("Reggio nell'Emilia")).toBe('reggio-nell-emilia');
    expect(slugify('Forlì-Cesena')).toBe('forli-cesena');
  });
});

describe('the outline of an area the website names in a code', () => {
  it('decodes the polyline the map is drawn from', () => {
    // The example from the polyline format's own description, which is the format idealista serves.
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');

    expect(points).toHaveLength(3);
    // GeoJSON counts longitude first, which is the opposite of the order the polyline carries.
    expect(points[0][0]).toBeCloseTo(-120.2, 5);
    expect(points[0][1]).toBeCloseTo(38.5, 5);
    expect(points[1][0]).toBeCloseTo(-120.95, 5);
    expect(points[2][1]).toBeCloseTo(43.252, 5);
  });

  it('reads every ring of an outline made of several pieces', () => {
    const rings = parseOutline('((_p~iF~ps|U_ulLnnqC_mqNvxq`@)(_p~iF~ps|U_ulLnnqC_mqNvxq`@))');
    expect(rings).toHaveLength(2);
  });

  /**
   * An outline is drawn for a map and carries a point every few metres. One area of it runs to
   * sixty kilobytes, and a search naming four would be sent as a quarter of a megabyte of body.
   */
  it('drops the points the shape does not need', () => {
    const straight = Array.from({ length: 50 }, (_, index) => [9 + index * 0.01, 45]);
    // A corner the tolerance cannot swallow, so the ring keeps its shape.
    const bent = [...straight, [9.5, 45.5], [9, 45]];

    expect(simplifyRing(straight)).toHaveLength(2);
    expect(simplifyRing(bent).length).toBeLessThan(bent.length);
    expect(simplifyRing(bent)).toContainEqual([9.5, 45.5]);
  });
});

describe('the location a code stands for', () => {
  /**
   * Every advert inside an area carries the id of the location it belongs to, and the id all of
   * them share is the location itself. This is what gives a code its meaning back, since nothing
   * published maps one to the other.
   */
  it('is the deepest id every advert in the area sits under', () => {
    expect(sharedLocationId(['0-EU-IT-BS-02-012-099-01', '0-EU-IT-BS-02-013-002-03', '0-EU-IT-BS-02-012-100'])).toBe(
      '0-EU-IT-BS-02',
    );
  });

  /**
   * An advert whose point fell across a provincial border would otherwise pull the answer up to the
   * country, and a search for the country is not the search the user asked for.
   */
  it('ignores the odd advert that fell outside the province', () => {
    expect(sharedLocationId(['0-EU-IT-BG-09-001-x', '0-EU-IT-BG-09-002-y', '0-EU-IT-RM-01-001-097'])).toBe(
      '0-EU-IT-BG-09',
    );
  });

  it('has no answer where there is nothing to read', () => {
    expect(sharedLocationId([])).toBeNull();
    expect(sharedLocationId(['0-EU-IT'])).toBeNull();
  });
});

/**
 * What the api's abuse wall reads in a caller is burst traffic and flapping identities, and a
 * refusal of it - a 407, or the edge simply dropping the connection - outlasts the single error.
 * These tests pin how the requests walk past it: one at a time, a breath apart, and silent for a
 * while after a refusal rather than knocking harder.
 */
describe('the breath between requests, and the silence after a refusal', () => {
  const PATH = '/api/3.5/it/search';

  const ok = () => ({ ok: true, status: 200, json: () => Promise.resolve({ elementList: [] }) });
  const refused = () => ({ ok: false, status: 407, text: () => Promise.resolve('{"httpStatus":407}') });

  /**
   * The api, replaced by a doorkeeper that records the moment of every knock after the token one.
   *
   * @param {() => any} mood what the search endpoint answers
   * @returns {number[]} the fake-clock instants the endpoint was knocked at
   */
  function mockApi(mood) {
    const knocks = [];
    vi.stubGlobal('fetch', (url) => {
      if (String(url).includes('/api/oauth/token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ access_token: 'token', expires_in: 43200 }),
        });
      }
      knocks.push(Date.now());
      return Promise.resolve(mood());
    });
    return knocks;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetPacing();
    forgetToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('walks requests out one at a time, a breath apart', async () => {
    const knocks = mockApi(ok);

    const pending = [call(PATH), call(PATH), call(PATH)];
    await vi.runAllTimersAsync();

    for (const attempt of pending) await expect(attempt).resolves.toEqual({ elementList: [] });
    expect(knocks).toHaveLength(3);
    expect(knocks[1] - knocks[0]).toBeGreaterThanOrEqual(REQUEST_GAP_MS);
    expect(knocks[2] - knocks[1]).toBeGreaterThanOrEqual(REQUEST_GAP_MS);
  });

  it('goes quiet when the api answers 407, and fails fast inside the silence', async () => {
    const knocks = mockApi(refused);

    // The rejection handler is attached before the clock runs, so no rejection flies loose.
    const refusal = expect(call(PATH)).rejects.toThrow(/407/);
    await vi.runAllTimersAsync();
    await refusal;

    // A minute into a quarter-hour silence the door is not knocked at all.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(call(PATH)).rejects.toThrow(/silent/);
    expect(knocks).toHaveLength(1);
  });

  it('asks again once the silence has passed, and one success clears the slate', async () => {
    let mood = refused;
    const knocks = mockApi(() => mood());

    const refusal = expect(call(PATH)).rejects.toThrow(/407/);
    await vi.runAllTimersAsync();
    await refusal;

    mood = ok;
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1000);

    const probe = call(PATH);
    const after = call(PATH);
    await vi.runAllTimersAsync();
    await expect(probe).resolves.toEqual({ elementList: [] });
    await expect(after).resolves.toEqual({ elementList: [] });
    expect(knocks).toHaveLength(3);
  });

  it('doubles the silence every time the refusal outlasts it', async () => {
    const knocks = mockApi(refused);

    let refusal = expect(call(PATH)).rejects.toThrow(/407/);
    await vi.runAllTimersAsync();
    await refusal;

    // Fifteen minutes later the refusal is still there, so the next silence is half an hour.
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    refusal = expect(call(PATH)).rejects.toThrow(/407/);
    await vi.runAllTimersAsync();
    await refusal;

    // Sixteen minutes into it the door stays unknocked...
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await expect(call(PATH)).rejects.toThrow(/silent/);
    expect(knocks).toHaveLength(2);

    // ...and only the full half hour opens it again.
    await vi.advanceTimersByTimeAsync(14 * 60_000 + 1000);
    refusal = expect(call(PATH)).rejects.toThrow(/407/);
    await vi.runAllTimersAsync();
    await refusal;
    expect(knocks).toHaveLength(3);
  });

  it('reads a slammed door only after several dropped connections in a row', async () => {
    let knocks = 0;
    vi.stubGlobal('fetch', (url) => {
      if (String(url).includes('/api/oauth/token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ access_token: 'token', expires_in: 43200 }),
        });
      }
      knocks += 1;
      return Promise.reject(new TypeError('fetch failed'));
    });

    // One reset is weather, so the weather gets its retries...
    for (let i = 0; i < 3; i++) {
      const dropped = expect(call(PATH)).rejects.toThrow('fetch failed');
      await vi.runAllTimersAsync();
      await dropped;
    }
    expect(knocks).toBe(3);

    // ...but by the third in a row the door is read as slammed, and stays unknocked.
    await expect(call(PATH)).rejects.toThrow(/silent/);
    expect(knocks).toBe(3);
  });
});
