/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGeoLocationId } from '../../../lib/services/smg/geoLocations.js';

/**
 * The location lookup both Swiss SMG providers share.
 *
 * The endpoint is an autocomplete, so one name answers many places, and only the entry that spells
 * the URL's own slug is that URL's place. The recorded Chiasso answer is the real one: the city
 * carries `luogo-chiasso` in `urlNames`, and the zip beside it carries `npa-6830-chiasso` in
 * `is24UrlNames`.
 */
const CHIASSO = JSON.parse(
  readFileSync(new URL('../../testFixtures/homegate_locations_chiasso.json', import.meta.url), 'utf-8'),
);

/** @param {any} body @returns {any} a response-shaped object */
const answer = (body) => ({ ok: true, status: 200, json: async () => body });

describe('the SMG location lookup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves the slug off the recorded answer, asking in the language of the URL', async () => {
    const asked = [];
    vi.stubGlobal('fetch', async (url) => {
      asked.push(String(url));
      return answer(CHIASSO);
    });

    await expect(
      resolveGeoLocationId({ endpoint: 'https://api.homegate.ch/geo/locations', slug: 'luogo-chiasso', lang: 'it' }),
    ).resolves.toBe('geo-city-chiasso');

    // The kind prefix is dropped for the ask, and the ask carries the URL's language.
    expect(asked[0]).toBe('https://api.homegate.ch/geo/locations?lang=it&name=chiasso');
  });

  it('matches the is24UrlNames spelling as well as urlNames', async () => {
    vi.stubGlobal('fetch', async () => answer(CHIASSO));

    await expect(
      resolveGeoLocationId({
        endpoint: 'https://api.immoscout24.ch/geo/locations',
        slug: 'npa-6830-chiasso',
        lang: 'it',
      }),
    ).resolves.toBe('geo-zipcode-6830');
  });

  it('returns null instead of the first answer when no entry spells the slug', async () => {
    vi.stubGlobal('fetch', async () =>
      answer({ results: [{ geoLocation: { id: 'geo-city-lugano', urlNames: { it: 'luogo-lugano' } } }] }),
    );

    await expect(
      resolveGeoLocationId({
        endpoint: 'https://api.immoscout24.ch/geo/locations',
        slug: 'luogo-chiasso',
        lang: 'it',
      }),
    ).resolves.toBeNull();
  });

  it('asks for the whole slug as the second candidate', async () => {
    const asked = [];
    vi.stubGlobal('fetch', async (url) => {
      const name = new URL(url).searchParams.get('name');
      asked.push(name);
      if (name === 'zuerich-seefeld') {
        return answer({
          results: [{ geoLocation: { id: 'geo-city-zuerich-seefeld', urlNames: { de: 'zuerich-seefeld' } } }],
        });
      }
      return answer({ results: [] });
    });

    await expect(
      resolveGeoLocationId({ endpoint: 'https://api.homegate.ch/geo/locations', slug: 'zuerich-seefeld', lang: 'de' }),
    ).resolves.toBe('geo-city-zuerich-seefeld');

    expect(asked).toEqual(['seefeld', 'zuerich-seefeld']);
  });
});
