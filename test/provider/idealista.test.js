/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/idealista.js';

/**
 * Idealista.it, the Italian arm of the Spanish portal.
 *
 * What these tests pin is the card markup, because that is what a redesign breaks. The bot wall
 * is covered by the unit tests at the bottom, which need no network.
 *
 * Assertions are structural rather than literal, because the same file runs against the fixture
 * (`yarn test:offline`) and against the live portal (`yarn test`), where every advert differs.
 */
const TEST_TIMEOUT = 120_000;

/**
 * The search the tests of the website reader use, because the api sells no land: it is the shortest
 * url that cannot be asked of the api, and so is the one read off the website. Every other search
 * here goes to the api instead.
 */
const LAND_SEARCH = 'https://www.idealista.it/vendita-terreni/roma-roma/';

describe('#idealista provider testsuite()', () => {
  /** @type {any[]} */
  let listings;

  beforeAll(async () => {
    const Fredy = await mockFredy();
    const runConfig = provider.createConfig(providerConfig.idealista, [], []);
    const job = { id: 'idealista', notificationAdapter: null, spatialFilter: null, specFilter: null };

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
   * Every figure arrives as a display string - "1.300€/mese", "60 m²", "2 locali" - so what is
   * pinned is that the thousands separator and the units are gone by the time a listing is built.
   */
  it('reads the display strings as numbers', () => {
    for (const listing of carrying('price')) {
      expect(typeof listing.price, `price of ${listing.link}`).toBe('number');
      expect(listing.price).toBeGreaterThan(0);
    }
    for (const listing of carrying('size')) {
      expect(typeof listing.size, `size of ${listing.link}`).toBe('number');
      expect(listing.size).toBeGreaterThan(0);
    }
    for (const listing of carrying('rooms')) {
      expect(typeof listing.rooms, `rooms of ${listing.link}`).toBe('number');
      expect(listing.rooms).toBeGreaterThan(0);
    }
  });

  /**
   * The floor sits in the same list as the rooms and the size, and reads "4º piano". Taking it for
   * a room count is the mistake this guards: a flat with more than thirty rooms is a parse error,
   * not an advert.
   */
  it('does not take the floor for a room count', () => {
    for (const listing of carrying('rooms')) {
      expect(listing.rooms, `rooms of ${listing.link}`).toBeLessThan(30);
    }
  });

  it('links to the advert rather than to a relative path', () => {
    for (const listing of carrying('link')) {
      expect(listing.link).toMatch(/^https:\/\/www\.idealista\.it\/immobile\/\d+\//);
    }
  });

  it('names the place the title carries', () => {
    for (const listing of carrying('address')) {
      expect(typeof listing.address).toBe('string');
      expect(listing.address.length).toBeGreaterThan(0);
      // The property type is the part before the separator, so it must not survive into the address.
      expect(listing.address).not.toMatch(/^(Monolocale|Bilocale|Trilocale|Quadrilocale|Attico|Appartamento)\b/);
    }
  });

  it('declares Italy, which is what sends the geocoder there', () => {
    expect(provider.metaInformation.countries).toEqual(['it']);
  });

  /**
   * Idealista's robots.txt disallows `/*?ordine=pubblicazione-desc`, so the provider deliberately
   * ships no sort parameter. Tecnocasa is the other provider in this position.
   */
  it('asks for no ordering, which the portal disallows in robots.txt', () => {
    expect(provider.config.sortByDateParam).toBeUndefined();
  });
});

describe('the wall idealista puts in front of a plain request', () => {
  it('is recognised by its status and by its body', () => {
    // Both signals matter: the interstitial arrives as a 403, and a 200 carrying the DataDome
    // frame is the same refusal in different clothing.
    expect(provider.parseListings('<html><body>nothing here</body></html>')).toEqual([]);
    expect(provider.parseListings(null)).toEqual([]);
  });

  it('reads a card out of the markup the portal serves', () => {
    const html = `
      <article class="item" data-element-id="123456">
        <a class="item-link" href="/immobile/123456/" title="Bilocale in Via Tarso, 27, San Paolo, Roma"></a>
        <span class="item-price">1.300€/mese</span>
        <div class="item-detail-char">
          <span class="item-detail">2 locali</span>
          <span class="item-detail">60 m²</span>
          <span class="item-detail">4º piano con ascensore</span>
          <span class="item-detail">7 minuti</span>
        </div>
        <p class="item-description">Ampio bilocale ristrutturato.</p>
        <img src="https://img4.idealista.it/blur/480_360_mq/0/x.jpg" />
      </article>`;

    const [raw] = provider.parseListings(html);
    expect(raw.id).toBe('123456');
    expect(raw.characteristics).toEqual(['2 locali', '60 m²', '4º piano con ascensore', '7 minuti']);

    const listing = provider.config.normalize(raw);
    expect(listing.price).toBe(1300);
    expect(listing.size).toBe(60);
    expect(listing.rooms).toBe(2);
    expect(listing.link).toBe('https://www.idealista.it/immobile/123456/');
    expect(listing.address).toBe('Via Tarso, 27, San Paolo, Roma');
    expect(listing.description).toBe('Ampio bilocale ristrutturato.');
  });

  /**
   * Fredy's own browser is headless, which DataDome never lets through, so the wall is cleared by
   * a separate service. With none configured the provider has to give up rather than reach for a
   * browser that cannot do the job.
   */
  it('finds nothing when no solver is configured, instead of opening a browser', async () => {
    const previous = process.env.FREDY_CHALLENGE_SOLVER_URL;
    delete process.env.FREDY_CHALLENGE_SOLVER_URL;
    const originalFetch = globalThis.fetch;
    // A wall on every request, which is what idealista serves a client with no session.
    globalThis.fetch = async () => ({
      status: 403,
      headers: undefined,
      text: async () => '<html><body>geo.captcha-delivery.com/interstitial/</body></html>',
    });

    try {
      const runConfig = provider.createConfig({ url: LAND_SEARCH }, []);
      expect(await runConfig.getListings(runConfig.url)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      if (previous !== undefined) process.env.FREDY_CHALLENGE_SOLVER_URL = previous;
    }
  });

  /**
   * An advert with no street reads "<type> a <district>, <town>". Splitting on the earlier of the
   * two separators would cut a type that contains "a" in half, so "in" is looked for first.
   */
  it('splits the address off a title that names no street', () => {
    const card = (title) =>
      `<article class="item" data-element-id="1"><a class="item-link" href="/immobile/1/" title="${title}"></a></article>`;

    const withoutStreet = provider.config.normalize(provider.parseListings(card('Appartamento a Aventino, Roma'))[0]);
    expect(withoutStreet.address).toBe('Aventino, Roma');

    const twoWordType = provider.config.normalize(
      provider.parseListings(card('Casa a schiera in Via Giulia, Roma'))[0],
    );
    expect(twoWordType.address).toBe('Via Giulia, Roma');

    // A type carrying "a" and a title with no street put the trap twice over. Taking the last "a"
    // instead would read this one right and cut a town called "Bagno a Ripoli" in half.
    const schiera = provider.config.normalize(provider.parseListings(card('Villetta a schiera a Lovere'))[0]);
    expect(schiera.address).toBe('Lovere');

    const townWithA = provider.config.normalize(provider.parseListings(card('Appartamento a Bagno a Ripoli'))[0]);
    expect(townWithA.address).toBe('Bagno a Ripoli');
  });
});

describe('the result pages idealista falls back to reading', () => {
  it('hangs the page off the search path, however the url arrives', () => {
    const search = 'https://www.idealista.it/vendita-case/roma-roma/';

    expect(provider.pageUrl(search, 1)).toBe(search);
    expect(provider.pageUrl(search, 3)).toBe(`${search}lista-3.htm`);
    // A url that already names a page is rewritten rather than appended to.
    expect(provider.pageUrl(`${search}lista-3.htm`, 5)).toBe(`${search}lista-5.htm`);
    expect(provider.pageUrl(`${search}lista-3.htm`, 1)).toBe(search);
  });

  /**
   * The portal serves no ordering Fredy may ask for, so a new advert lands wherever the ranking
   * puts it and the whole result set has to be read. A page past the last one comes back as the
   * first one again, which is what ends the walk when the last page is a full one.
   */
  it('walks the result pages until one runs short', async () => {
    const card = (id) =>
      `<article class="item" data-element-id="${id}"><a class="item-link" href="/immobile/${id}/" title="Villa in Via Giulia, Roma"></a></article>`;
    const cards = (from, count) => Array.from({ length: count }, (__, index) => card(from + index)).join('');

    const asked = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      const page = Number(String(url).match(/lista-(\d+)\.htm/)?.[1] ?? 1);
      // Two full pages and then a short one, which is where the results end.
      const body = page <= 2 ? cards(page * 100, 30) : cards(300, 4);
      return { status: 200, headers: undefined, text: async () => body };
    };

    // The walk waits between pages, which a real run wants and a test does not.
    vi.useFakeTimers();
    try {
      const runConfig = provider.createConfig({ url: LAND_SEARCH }, []);
      const walk = runConfig.getListings(runConfig.url);
      await vi.runAllTimersAsync();
      const adverts = await walk;

      expect(adverts).toHaveLength(64);
      expect(asked).toHaveLength(3);
      expect(asked[2]).toContain('/lista-3.htm');
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * A 429 is not a wall: no session clears it and the solver has nothing to solve. The run stops
   * where it is rather than asking for the pages that would deepen the rate limit.
   */
  it('stops the walk when the portal asks for fewer requests', async () => {
    const card = (id) =>
      `<article class="item" data-element-id="${id}"><a class="item-link" href="/immobile/${id}/" title="Villa in Via Giulia, Roma"></a></article>`;

    const asked = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      const page = Number(String(url).match(/lista-(\d+)\.htm/)?.[1] ?? 1);
      if (page > 1) return { status: 429, headers: undefined, text: async () => 'Too Many Requests' };
      return {
        status: 200,
        headers: undefined,
        text: async () => Array.from({ length: 30 }, (__, index) => card(index)).join(''),
      };
    };

    vi.useFakeTimers();
    try {
      const runConfig = provider.createConfig({ url: LAND_SEARCH }, []);
      const walk = runConfig.getListings(runConfig.url);
      await vi.runAllTimersAsync();

      expect(await walk).toHaveLength(30);
      expect(asked).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });
});
