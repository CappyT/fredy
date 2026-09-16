/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readCategory } from '../../lib/services/immobiliare/web-paths.js';
import { clearPlaceCache, resolvePlace, toQuery } from '../../lib/services/immobiliare/geography.js';
import { translateSearchUrl } from '../../lib/services/immobiliare/web-translator.js';
import {
  buildAppSearch,
  getAppListings,
  normalizeAppListing,
  pointsFromVrt,
} from '../../lib/services/immobiliare/appApi.js';

/**
 * The datadome module is mocked so the 403 branch is exercised without a solver, a proxy or the
 * token store. `answer.solved` is the cookie the solver would hand back, per test.
 */
const datadome = vi.hoisted(() => ({ token: null, solved: null }));

/** What the app api writes to the log, so a refusal line can be read back. */
const logged = vi.hoisted(() => []);
vi.mock('../../lib/services/logger.js', () => ({
  default: {
    error: (...args) => logged.push(args.join(' ')),
    warn: (...args) => logged.push(args.join(' ')),
    info: () => {},
    debug: () => {},
  },
}));
vi.mock('../../lib/services/datadome.js', () => ({
  SOLVE_USER_AGENT: 'test-solve-agent',
  readToken: () => datadome.token,
  tokenForBlock: async () => datadome.solved,
  isDataDomeBlock: (status, body) => status === 403 && String(body).includes('captcha-delivery.com'),
  captchaUrlIn: (body) => {
    try {
      return JSON.parse(body)?.url ?? null;
    } catch {
      return null;
    }
  },
  isSolveable: (url) => {
    try {
      return new URL(url).searchParams.get('t') === 'fe';
    } catch {
      return false;
    }
  },
}));

/**
 * A town search on immobiliare.it names its town in words and the search endpoint wants the number
 * the portal calls it by. Looking that number up is what lets a town search be asked for over
 * plain http, where it used to need a browser and a bot wall, so what these tests pin is the
 * reading of the url and the reading of the answer - not the service itself, which is mocked.
 *
 * `reverse-engineered-immobiliare.md` records where each of these facts was measured.
 */

/** One answer of the geography service, as it comes back for `erbusco`. */
const ERBUSCO = [
  {
    id: '7369',
    type: 2,
    label: 'Erbusco',
    parents: [
      { id: 'BS', type: 1, label: 'Brescia' },
      { id: 'lom', type: 0, label: 'Lombardia' },
      { id: 'IT', type: -1, label: 'Italia' },
    ],
  },
];

/** What the service answers for `citta-studi`, whose label qualifies it with another place. */
const CITTA_STUDI = [
  {
    id: '10070',
    type: 3,
    label: 'Città Studi, Susa',
    parents: [
      { id: '8042', type: 2, label: 'Milano' },
      { id: 'MI', type: 1, label: 'Milano' },
      { id: 'lom', type: 0, label: 'Lombardia' },
      { id: 'IT', type: -1, label: 'Italia' },
    ],
  },
];

/**
 * The service ranks by relevance, so a query answers with places of every level and the wrong one
 * often ranks first. "Brescia" is a province, the city in it, and a quarter of a town in Rimini.
 */
const BRESCIA = [
  { id: '50124', type: 3, label: 'Brescia', parents: [{ id: '7967', type: 2, label: 'San Giovanni in Marignano' }] },
  { id: '7329', type: 2, label: 'Brescia', parents: [{ id: 'BS', type: 1, label: 'Brescia' }] },
  { id: 'BS', type: 1, label: 'Brescia', parents: [{ id: 'lom', type: 0, label: 'Lombardia' }] },
];

/**
 * @param {Record<string, any[]>} byQuery What to answer for each query.
 * @returns {any} a fetch replacement
 */
function serve(byQuery) {
  return vi.fn(async (url) => {
    const asked = new URL(String(url)).searchParams.get('query') ?? '';
    const found = byQuery[asked];
    if (found == null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => found };
  });
}

describe('the place a search url names', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearPlaceCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('asks for the place in the words the url spells it with', () => {
    expect(toQuery('citta-studi')).toBe('citta studi');
    expect(toQuery('erbusco')).toBe('erbusco');
  });

  it('names the place and every place above it, which is what the endpoint filters by', async () => {
    globalThis.fetch = serve({ erbusco: ERBUSCO });

    expect(await resolvePlace(['erbusco'])).toEqual({
      idNazione: 'IT',
      fkRegione: 'lom',
      idProvincia: 'BS',
      idComune: '7369',
    });
  });

  /**
   * A quarter is named by two segments because its own name does not identify it - there is a
   * Città Studi in Milan and another one elsewhere - so the town is asked for alongside it.
   */
  it('reads a quarter as a quarter of the town the url names', async () => {
    globalThis.fetch = serve({ 'citta studi milano': CITTA_STUDI });
    const place = await resolvePlace(['milano', 'citta-studi']);

    expect(place).toMatchObject({ idComune: '8042', 'idMZona[]': '10070' });
  });

  /**
   * The url's grammar says which level is meant, and it has to: taking the best ranked answer would
   * read `/vendita-case/brescia/` as a quarter of a town in Rimini.
   */
  it('takes the level the url asks for rather than the best ranked answer', async () => {
    globalThis.fetch = serve({ brescia: BRESCIA });

    expect(await resolvePlace(['brescia'])).toMatchObject({ idComune: '7329' });
    clearPlaceCache();
    // The website spells a whole province this way, and means every town in it.
    expect(await resolvePlace(['brescia-provincia'])).toEqual({ fkRegione: 'lom', idProvincia: 'BS' });
  });

  it('has no answer for a place the service does not know', async () => {
    globalThis.fetch = serve({});
    expect(await resolvePlace(['nowhere-at-all'])).toBeNull();
    expect(await resolvePlace([])).toBeNull();
  });

  /**
   * A town keeps its id, so a resolved lookup is remembered for the lifetime of the process. That
   * makes "no such place" and "the service could not be read just now" two different answers, and
   * they used to be the same one: a 503 remembered as the former sent every run of every job
   * searching that town back through the browser and its bot wall, until Fredy was restarted.
   */
  it('asks again after a failure, and answers once the service is back', async () => {
    let asked = 0;
    globalThis.fetch = vi.fn(async () => {
      asked += 1;
      return asked === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ERBUSCO };
    });

    expect(await resolvePlace(['erbusco'])).toBeNull();
    expect(await resolvePlace(['erbusco'])).toMatchObject({ idComune: '7369' });
    expect(asked).toBe(2);
  });

  it('asks once for a place the service says it does not have', async () => {
    const fetcher = serve({});
    globalThis.fetch = fetcher;

    expect(await resolvePlace(['nowhere-at-all'])).toBeNull();
    expect(await resolvePlace(['nowhere-at-all'])).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('the search a website url describes', () => {
  it('reads what is on offer and on what terms', () => {
    expect(readCategory('vendita-case')).toEqual({ idContratto: '1', idCategoria: '1' });
    expect(readCategory('affitto-case')).toEqual({ idContratto: '2', idCategoria: '1' });
    expect(readCategory('vendita-ville')).toEqual({ idContratto: '1', idCategoria: '1', 'idTipologia[]': '12' });
    expect(readCategory('affitto-case-indipendenti')).toEqual({
      idContratto: '2',
      idCategoria: '1',
      'idTipologia[]': '7',
    });
    // Offices are their own category rather than a kind of home, and 23 rather than the 2 that
    // reads as commercial - which answers with houses.
    expect(readCategory('vendita-uffici')).toEqual({ idContratto: '1', idCategoria: '23' });
    expect(readCategory('affitto-stanze')).toEqual({ idContratto: '2', idCategoria: '4' });
    expect(readCategory('case')).toBeNull();
    expect(readCategory('vendita-astronavi')).toBeNull();
  });

  describe('read whole', () => {
    /** @type {any} */
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      clearPlaceCache();
      globalThis.fetch = serve({ erbusco: ERBUSCO });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('carries the filters over untouched, which is what makes an unknown one harmless', async () => {
      const criteria = await translateSearchUrl(
        'https://www.immobiliare.it/vendita-case/erbusco/?prezzoMassimo=300000&qualcosaDiNuovo=1',
      );

      expect(criteria).toContainEqual(['prezzoMassimo', '300000']);
      expect(criteria).toContainEqual(['qualcosaDiNuovo', '1']);
      expect(criteria).toContainEqual(['idComune', '7369']);
    });

    /**
     * The website says several things under one name. An object would keep the last of them, and a
     * search for two kinds of house would quietly become a search for the second.
     */
    it('keeps every value of a filter the url repeats', async () => {
      const criteria = await translateSearchUrl(
        'https://www.immobiliare.it/vendita-case/erbusco/?idTipologia%5B%5D=12&idTipologia%5B%5D=13',
      );

      expect(criteria?.filter(([name]) => name === 'idTipologia[]')).toEqual([
        ['idTipologia[]', '12'],
        ['idTipologia[]', '13'],
      ]);
    });

    it('drops the page, which belongs to the request rather than to the search', async () => {
      const criteria = await translateSearchUrl('https://www.immobiliare.it/vendita-case/erbusco/?pag=4');
      expect(criteria?.some(([name]) => name === 'pag')).toBe(false);
    });

    /**
     * The pipeline appends the sort to the url so that the search carries it, so it travels with
     * the other filters rather than being dropped as a per-request setting.
     */
    it('keeps the sort the pipeline asked for', async () => {
      const criteria = await translateSearchUrl(
        'https://www.immobiliare.it/vendita-case/erbusco/?criterio=data&ordine=desc',
      );

      expect(criteria).toContainEqual(['criterio', 'data']);
      expect(criteria).toContainEqual(['ordine', 'desc']);
    });

    it('gives up on a url it cannot read whole, so the caller renders it instead', async () => {
      expect(await translateSearchUrl('https://www.immobiliare.it/vendita-astronavi/erbusco/')).toBeNull();
      expect(await translateSearchUrl('https://www.immobiliare.it/vendita-case/')).toBeNull();
      expect(await translateSearchUrl('not a url')).toBeNull();
    });
  });
});

describe('the search the app api is asked for', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearPlaceCache();
    globalThis.fetch = serve({ erbusco: ERBUSCO, roma: ERBUSCO, brescia: BRESCIA, 'citta studi milano': CITTA_STUDI });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * The app api ignores a parameter it does not know rather than refusing it, so a filter this
   * cannot translate would silently widen the search. The one safe answer is to refuse the url and
   * let the provider render it instead.
   */
  it('refuses a url carrying a filter it cannot translate, rather than searching wider', async () => {
    const criteria = await translateSearchUrl('https://www.immobiliare.it/vendita-case/erbusco/?qualcosaDiNuovo=1');
    expect(criteria).not.toBeNull();

    expect(await buildAppSearch('https://www.immobiliare.it/vendita-case/erbusco/?qualcosaDiNuovo=1')).toBeNull();
  });

  it('reads a town into the app vocabulary: place, offer and sort', async () => {
    const params = await buildAppSearch('https://www.immobiliare.it/vendita-case/erbusco/?criterio=data&ordine=desc');

    expect(params).toBeInstanceOf(URLSearchParams);
    expect(params.get('c')).toBe('7369');
    expect(params.get('t')).toBe('v');
    expect(params.get('cat')).toBe('1');
    expect(params.get('of')).toBe('d');
    expect(params.get('od')).toBe('d');
    // The website's own sort and page names never reach the app api.
    expect(params.get('criterio')).toBeNull();
    expect(params.get('ordine')).toBeNull();
  });

  it('reads the filters whose meaning is established', async () => {
    const params = await buildAppSearch(
      'https://www.immobiliare.it/vendita-ville/erbusco/?prezzoMassimo=300000&superficieMinima=80',
    );

    expect(params.get('px')).toBe('300000');
    expect(params.get('sm')).toBe('80');
    expect(params.get('c')).toBe('7369');
  });

  /**
   * The api refuses a repeated `tip` with a 400 and reads a comma-joined list as several typologies
   * (measured 2026-09-16). Sending the website's repeated `idTipologia[]` one by one would cost a
   * browser render for a search the api can answer itself.
   */
  it('joins several typologies into the one value the api reads', async () => {
    const params = await buildAppSearch(
      'https://www.immobiliare.it/vendita-ville/erbusco/?idTipologia%5B%5D=12&idTipologia%5B%5D=13',
    );

    expect(params.getAll('tip')).toEqual(['12,13']);
    expect(params.get('c')).toBe('7369');
  });

  /**
   * The api answers 400 for `z2=a&z2=b` and matches nothing for `z2=a,b` (measured 2026-09-16), so a
   * url naming several quarters cannot be expressed. Keeping only the last value would silently
   * narrow the search to one quarter, which the caller must be able to fall back from.
   */
  it('refuses a url naming several quarters rather than narrowing it to one', async () => {
    expect(
      await buildAppSearch('https://www.immobiliare.it/vendita-case/erbusco/?idMZona%5B%5D=11355&idMZona%5B%5D=10910'),
    ).toBeNull();
    expect(
      await buildAppSearch(
        'https://www.immobiliare.it/search-list/?idContratto=1&idCategoria=1&idMZona%5B%5D=1&idMZona%5B%5D=2',
      ),
    ).toBeNull();
  });

  it('reads a map rectangle into the app polygon', async () => {
    const params = await buildAppSearch(
      'https://www.immobiliare.it/search-list/?idContratto=1&idCategoria=1&vrt=45.1%2C9.1%3B45.2%2C9.2',
    );

    expect(params.get('t')).toBe('v');
    expect(params.get('cat')).toBe('1');
    expect(params.get('points')).toBe('45.1,9.1 45.1,9.2 45.2,9.2 45.2,9.1');
  });

  /**
   * The website intersects a drawn area with the place the url also names. The api reads one scope
   * per request, so sending the area alone would answer beyond the place: the url is refused and the
   * website renders it.
   */
  it('refuses a drawn area that also names a place, rather than widening it', async () => {
    expect(
      await buildAppSearch(
        'https://www.immobiliare.it/search-list/?idContratto=1&idCategoria=1&idComune=8042&vrt=45.1%2C9.1%3B45.2%2C9.2',
      ),
    ).toBeNull();
  });

  it('takes the most specific scope a url carries', async () => {
    const params = await buildAppSearch(
      'https://www.immobiliare.it/search-list/?idContratto=1&idCategoria=1&idNazione=IT&fkRegione=lom&idProvincia=MI&idComune=8042',
    );

    expect(params.get('c')).toBe('8042');
    expect(params.get('pr')).toBeNull();
    expect(params.get('nationId')).toBeNull();
  });

  /**
   * Every place level and every filter the translation claims, each on the url shape the website
   * spells it with. A region and a nation have no url of their own - the path names a town, a
   * province or a quarter - so those two arrive on a map search, which is where the website itself
   * puts them.
   */
  it.each([
    ['a province', 'https://www.immobiliare.it/vendita-case/brescia-provincia/', { pr: 'BS', c: null, regionId: null }],
    ['a quarter', 'https://www.immobiliare.it/vendita-case/milano/citta-studi/', { z2: '10070', c: null }],
    [
      'a region',
      'https://www.immobiliare.it/search-list/?idContratto=1&idCategoria=1&idNazione=IT&fkRegione=lom',
      { regionId: 'lom', nationId: null },
    ],
    [
      'a nation',
      'https://www.immobiliare.it/search-list/?idContratto=1&idCategoria=1&idNazione=IT',
      { nationId: 'IT' },
    ],
    [
      'the price, surface and room bounds',
      'https://www.immobiliare.it/affitto-case/erbusco/?prezzoMinimo=500&superficieMassima=120&localiMinimo=2&localiMassimo=4',
      { pm: '500', sx: '120', lm: '2', lx: '4', t: 'a', c: '7369' },
    ],
  ])('reads %s into the app vocabulary', async (_name, url, expected) => {
    const params = await buildAppSearch(url);

    expect(params).toBeInstanceOf(URLSearchParams);
    for (const [name, value] of Object.entries(expected)) expect([name, params.get(name)]).toEqual([name, value]);
  });

  it('expands a two-corner rectangle to four corners and passes a polygon through', () => {
    expect(pointsFromVrt('45.1,9.1;45.2,9.2')).toBe('45.1,9.1 45.1,9.2 45.2,9.2 45.2,9.1');
    expect(pointsFromVrt('45.44,9.16 45.48,9.16 45.48,9.22')).toBe('45.44,9.16 45.48,9.16 45.48,9.22');
    expect(pointsFromVrt('nonsense')).toBeNull();
    expect(pointsFromVrt(null)).toBeNull();
  });
});

describe('reading the app api', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    datadome.token = null;
    datadome.solved = null;
    logged.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const MAP_URL = 'https://www.immobiliare.it/search-list/?idContratto=2&idCategoria=1&idNazione=IT&idComune=6737';

  it('walks the pages the api counts, by start', async () => {
    const asked = [];
    globalThis.fetch = vi.fn(async (url) => {
      asked.push(Number(new URL(String(url)).searchParams.get('start')));
      return {
        ok: true,
        status: 200,
        json: async () => ({ list: [{ id: 1 }], totalActive: 45 }),
      };
    });

    vi.useFakeTimers();
    try {
      const walk = getAppListings(MAP_URL, 20);
      await vi.runAllTimersAsync();
      const items = await walk;

      expect(asked).toEqual([0, 20, 40]);
      expect(items).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The kind is the whole of what the line is worth reading for: `it` and `bv` want another exit
   * address, `fe` wants a solver. It sits at the end of a url no log line keeps, so the line names
   * it, along with the page of the walk that was refused.
   */
  it('answers null when the api refuses the exit, so the provider renders instead', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ url: 'https://geo.captcha-delivery.com/interstitial/?t=it' }),
    }));

    await expect(getAppListings(MAP_URL)).resolves.toBeNull();
    expect(logged.join('\n')).toMatch(/DataDome it, not solvable/);
    expect(logged.join('\n')).toMatch(/page 1 of the walk/);
  });

  /**
   * A `fe` challenge the solver could not answer - no api key, no proxy, or a refused task - is the
   * same fallback, and the line has to say which kind it was so the two remedies stay apart.
   */
  it('names a solvable challenge it could not buy back', async () => {
    datadome.solved = null;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ url: 'https://geo.captcha-delivery.com/captcha/?t=fe' }),
    }));

    await expect(getAppListings(MAP_URL)).resolves.toBeNull();
    expect(logged.join('\n')).toMatch(/DataDome fe, solvable/);
    expect(logged.join('\n')).toMatch(/page 1 of the walk/);
  });

  /**
   * A `fe` challenge is the kind capsolver answers, so the read is retried once with the solved
   * cookie instead of paying a browser render for a search the api can still answer.
   */
  it('retries with the solved cookie when the guard can be solved', async () => {
    datadome.solved = 'datadome=solved';
    const cookies = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      cookies.push(init?.headers?.cookie ?? null);
      if (cookies.length === 1) {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ url: 'https://geo.captcha-delivery.com/captcha/?t=fe' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ list: [{ id: 9 }], totalActive: 1 }) };
    });

    const items = await getAppListings(MAP_URL);

    expect(cookies).toEqual([null, 'datadome=solved']);
    expect(items).toHaveLength(1);
  });

  /**
   * An empty answer is the api's verdict on a search that matched nothing - the api does not rewrite
   * its values the way the Swiss one does - so it is a result and not an excuse to render the page.
   */
  it('answers an empty list when the search matched nothing', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ list: [], totalActive: 0 }),
    }));

    await expect(getAppListings(MAP_URL)).resolves.toEqual([]);
  });

  it('answers null for a url it cannot express, without asking the api', async () => {
    const fetcher = vi.fn();
    globalThis.fetch = fetcher;

    await expect(getAppListings('https://www.immobiliare.it/vendita-astronavi/roma/')).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  /**
   * Every call to the app api wears the app's own header set. Reading the app api at all is the
   * requirement, and a client that does not look like the app is the one a bot guard watches for.
   */
  it('asks with the mobile header set', async () => {
    /** @type {any} */
    let headers = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      headers = init?.headers;
      return { ok: true, status: 200, json: async () => ({ list: [{ id: 1 }], totalActive: 1 }) };
    });

    await getAppListings(MAP_URL);

    expect(headers['user-agent']).toMatch(/^WSCommand3</);
    expect(headers['accept-language']).toBe('it-IT');
    expect(headers['x-currency']).toBe('EUR');
    expect(headers['x-measurement-unit']).toBe('meters');
    expect(headers['immo-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the flat app item', () => {
  /** One real item of the app search payload, trimmed to the fields the normalizer reads. */
  const ITEM = {
    id: 132460266,
    title: 'Appartamento',
    creationDate: 1789555412,
    lastModified: 1789562118,
    topology: { typology: { id: 4, name: 'Appartamento' }, surface: { size: 210 }, rooms: '5' },
    price: { value: '€ 1.880.000', raw: 1880000, isHidden: false },
    geography: {
      street: "Via San Francesco d'Assisi, 11",
      municipality: { id: 8042, name: 'Milano' },
      microzone: { id: 12633, name: 'Quadronno - Crocetta' },
      geolocation: { latitude: 45.4541, longitude: 9.19 },
    },
    media: { images: [{ sd: 'https://pwm.im-cdn.it/image/1/m-c.jpg', hd: 'https://pwm.im-cdn.it/image/1/xxl.jpg' }] },
  };

  it('reads into the same listing fields the website payload produces', () => {
    expect(normalizeAppListing(ITEM)).toMatchObject({
      title: "Appartamento Via San Francesco d'Assisi, 11, Quadronno - Crocetta, Milano",
      link: 'https://www.immobiliare.it/annunci/132460266/',
      price: 1880000,
      size: 210,
      rooms: 5,
      address: "Via San Francesco d'Assisi, 11, Milano",
      latitude: 45.4541,
      longitude: 9.19,
      image: 'https://pwm.im-cdn.it/image/1/xxl.jpg',
      publishedAt: 1789562118000,
    });
    expect(normalizeAppListing(ITEM).id).toBeTruthy();
  });

  it('leaves the price off an advert whose owner hid it', () => {
    const listing = normalizeAppListing({ ...ITEM, price: { ...ITEM.price, isHidden: true } });

    expect(listing.price).toBeNull();
    // The hash does not depend on a figure that is not there.
    expect(listing.id).toBeTruthy();
  });

  /**
   * The app id is the number the advert is addressed by, and price is what separates two adverts on
   * one page, so the hash is the same one the website path builds for the same advert - which is
   * what keeps a job that switches path from re-notifying a listing it already stored. Both recipes
   * are read here, rather than one of them being written out again, so a change to either one fails.
   */
  it('builds the same hash the website path builds for the same advert and price', async () => {
    const website = JSON.parse(
      readFileSync(new URL('../testFixtures/immobiliare_list.json', import.meta.url), 'utf-8'),
    );
    const websiteItem = website.results[0];
    const { config } = await import('../../lib/provider/immobiliare.js');

    const appItem = {
      id: websiteItem.realEstate.id,
      price: { raw: websiteItem.realEstate.price.value, isHidden: false },
      topology: { typology: { name: 'Appartamento' } },
      geography: { municipality: { name: 'Roma' } },
    };

    expect(normalizeAppListing(appItem).id).toBe(config.normalize(websiteItem).id);
  });
});
