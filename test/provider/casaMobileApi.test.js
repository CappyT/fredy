/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFilters } from '../../lib/services/casa/search-filters.js';
import { clearPlaceCache, resolvePlace, LEVELS } from '../../lib/services/casa/geography.js';
import { translateSearchUrl } from '../../lib/services/casa/web-translator.js';

/**
 * Casa.it is read through the api its android app talks to, and a job holds the url a user copied
 * out of their browser, so the whole provider rests on reading that url correctly.
 *
 * This api never says no. It drops a filter name it does not know without a word and answers a
 * property group it does not know with the residential one, so every mistake below would show up
 * as a search that quietly returns the wrong adverts rather than as a failure. That is what these
 * tests are for.
 *
 * `reverse-engineered-casa.md` records where each fact was measured.
 */

/** What the place lookup answers for `roma`: the province and the town share the name. */
const ROMA = {
  data: {
    results: [
      { hkey: 'ed427fcb', id: 'IT-LAZ-RM', level: 6, name: 'Roma', slugs: 'roma', type: 'province' },
      { hkey: 'a0d22860', id: 'IT-LAZ-058091', level: 9, name: 'Roma', slugs: 'roma', type: 'main_town' },
    ],
  },
};

/**
 * @param {Record<string, any>} byQuery
 * @returns {any}
 */
function serve(byQuery) {
  return vi.fn(async (url) => {
    const asked = new URL(String(url)).searchParams.get('query') ?? '';
    const found = byQuery[asked];
    if (found == null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => found };
  });
}

describe('the filters a casa.it url carries', () => {
  /**
   * The website encodes a value with an encoder of its own: a space becomes `+`, a comma becomes
   * `%2C`. The api is fed the result of that verbatim, so the list separator in the url is the
   * escaped comma while the `+` inside an item has to survive untouched.
   *
   * Decoding the value on the way through is the expensive mistake here. `casa+indipendente` finds
   * the houses and `casa indipendente` finds none of them, and the api reports neither as an error.
   */
  it('splits a list on the escaped comma and leaves the plus alone', () => {
    const read = readFilters('?propertyTypes=casa+indipendente%2Cvilla%2Cvilletta+a+schiera');

    expect(read?.filters['property.types']).toEqual(['casa+indipendente', 'villa', 'villetta+a+schiera']);
  });

  it('pairs the two ends of a range into the one object the api takes', () => {
    const read = readFilters('?priceMin=200000&priceMax=450000&mqMin=80&numRoomsMin=3');

    expect(read?.filters).toMatchObject({
      price: { gte: 200000, lte: 450000 },
      surface: { gte: 80 },
      rooms: { gte: 3 },
    });
  });

  it('reads a figure as a number and a word as a word', () => {
    const read = readFilters('?priceMin=200000&tr=vendita&buildingCondition=abitabile');

    expect(read?.filters.price.gte).toBe(200000);
    expect(read?.filters['transaction.type']).toBe('vendita');
    expect(read?.filters.building_condition).toEqual(['abitabile']);
  });

  it('keeps the area out of the filters, for the translator to read', () => {
    const read = readFilters('?tr=vendita&geopolygon=%7B%22polygon%22%3A%5B%5D%7D');

    expect(read?.area.geopolygon).toBe('{"polygon":[]}');
    expect(read?.filters.geopolygon).toBeUndefined();
  });

  it('drops the page, which belongs to the request rather than to the search', () => {
    expect(readFilters('?tr=vendita&page=4')?.filters.page).toBeUndefined();
  });

  /**
   * Passing an unknown name through would be worse than refusing it: this api ignores what it does
   * not recognise, so the search would run without that filter and nobody would be told.
   */
  it('refuses a url carrying a filter it has no counterpart for', () => {
    expect(readFilters('?tr=vendita&qualcosaDiNuovo=1')).toBeNull();
  });
});

describe('the place a casa.it url names', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearPlaceCache();
    globalThis.fetch = serve({ roma: ROMA });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * A name alone does not identify a place, and the id casa.it prints elsewhere is not accepted by
   * the search - sent as `id` it is ignored and the search widens to the whole country.
   */
  it('answers with the key of the level asked for', async () => {
    expect(await resolvePlace('roma')).toEqual({ hkey: 'a0d22860', level: 9 });
    clearPlaceCache();
    expect(await resolvePlace('roma', [LEVELS.province])).toEqual({ hkey: 'ed427fcb', level: 6 });
  });

  it('has no answer for a place the lookup does not know', async () => {
    expect(await resolvePlace('nowhere-at-all')).toBeNull();
  });
});

describe('the search a casa.it url describes', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearPlaceCache();
    globalThis.fetch = serve({ roma: ROMA });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads a town search out of its path', async () => {
    const search = await translateSearchUrl('https://www.casa.it/affitto/residenziale/roma/');

    expect(search).toEqual({
      where: [{ hkey: 'a0d22860', level: 9 }],
      filters: { 'transaction.type': 'affitto', property_type_group: 'case' },
    });
  });

  /**
   * The url writes a point as [lat, lon] and the api reads it as [lon, lat]. Sent in the url's own
   * order the api answers nothing at all, which reads as a search with no results rather than as
   * the mistake it is.
   */
  it('turns a drawn area the way round the api reads it', async () => {
    const ring = '{"polygon":[[45.6,9.8],[45.7,9.9],[45.5,10.0],[45.6,9.8]]}';
    const search = await translateSearchUrl(
      `https://www.casa.it/srp/map/?tr=vendita&geopolygon=${encodeURIComponent(ring)}`,
    );

    expect(search?.where).toEqual([
      {
        geo: {
          polygon: [
            [9.8, 45.6],
            [9.9, 45.7],
            [10.0, 45.5],
            [9.8, 45.6],
          ],
        },
      },
    ]);
  });

  it('gives up on a url it cannot read whole, so the caller renders it instead', async () => {
    // A category outside the confirmed table: the api would answer with the residential one.
    expect(await translateSearchUrl('https://www.casa.it/vendita/commerciale/roma/')).toBeNull();
    // A place the lookup does not know.
    expect(await translateSearchUrl('https://www.casa.it/vendita/residenziale/nowhere-at-all/')).toBeNull();
    // A drawn search with nothing drawn.
    expect(await translateSearchUrl('https://www.casa.it/srp/map/?tr=vendita')).toBeNull();
    expect(await translateSearchUrl('not a url')).toBeNull();
  });
});
