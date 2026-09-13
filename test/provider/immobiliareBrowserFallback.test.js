/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { extract, translate, browserApi } = vi.hoisted(() => ({
  extract: vi.fn(),
  translate: vi.fn(),
  browserApi: vi.fn(),
}));
vi.mock('../../lib/services/extractor/puppeteerExtractor.js', () => ({ default: extract }));
vi.mock('../../lib/services/immobiliare/web-translator.js', () => ({
  MAP_SEARCH_PATH: '/search-list/',
  translateSearchUrl: translate,
}));
import { createConfig } from '../../lib/provider/immobiliare.js';

const MAP = 'https://www.immobiliare.it/search-list/?vrt=45.1%2C9.1%3B45.2%2C9.2&idTipologia[]=12&idTipologia[]=13';
const response = (status, payload) => ({
  ok: status === 200,
  status,
  statusText: String(status),
  json: async () => payload,
  text: async () => 'refused',
});
const payload = (id, maxPages = 1) => ({ results: [{ realEstate: { id, title: 'House & garden' } }], maxPages });
const run = (url, browser) => createConfig({ url }).getListings(url, browser);

beforeEach(() => {
  vi.useFakeTimers();
  browserApi.mockReset();
  extract.mockReset().mockImplementation(async (_url, _selector, options) => {
    await options.onPage({ evaluate: async (_fn, target) => browserApi(target) });
    return '<body>map search</body>';
  });
  translate.mockReset().mockResolvedValue({ idComune: '8042', idContratto: '1' });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function complete(pending) {
  await vi.runAllTimersAsync();
  return pending;
}

describe('Immobiliare API browser fallback', () => {
  it('switches a blocked map search to the exact API request and keeps subsequent pages in the browser', async () => {
    const browser = {};
    fetch.mockResolvedValue(response(403));
    browserApi.mockImplementation(async (url) => ({
      status: 200,
      payload: payload(Number(new URL(url).searchParams.get('pag')), 2),
    }));
    const results = await complete(run(MAP, browser));
    expect(results.map((row) => row.realEstate.id)).toEqual([1, 2]);
    expect(results[0].realEstate.title).toBe('House & garden');
    expect(fetch).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledTimes(2);
    for (const [index, [url, selector, options]] of extract.mock.calls.entries()) {
      expect(url).toBe('https://www.immobiliare.it/');
      const target = new URL(browserApi.mock.calls[index][0]);
      expect(target.pathname).toBe('/api-next/search-list/listings/');
      expect(target.searchParams.get('path')).toBe('/search-list/');
      expect(target.searchParams.get('vrt')).toBe('45.1,9.1;45.2,9.2');
      expect(target.searchParams.getAll('idTipologia[]')).toEqual(['12', '13']);
      expect(target.searchParams.get('pag')).toBe(String(index + 1));
      expect(selector).toBe('body');
      expect(options).toMatchObject({ browser, datadome: true });
    }
  });

  it('fetches the API with browser credentials after opening the HTML homepage', async () => {
    fetch.mockResolvedValueOnce(response(403)).mockResolvedValueOnce(response(200, payload(1)));
    extract.mockImplementation(async (url, _selector, options) => {
      expect(url).toBe('https://www.immobiliare.it/');
      await options.onPage({ evaluate: (fn, target) => fn(target) });
      return '<body>homepage</body>';
    });
    expect(await complete(run(MAP, {}))).toHaveLength(1);
    expect(fetch.mock.calls[1][1]).toEqual({ credentials: 'include', headers: { Accept: 'application/json' } });
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('vrt')).toBe('45.1,9.1;45.2,9.2');
  });

  it('retains early API results when a later page is challenged', async () => {
    fetch.mockResolvedValueOnce(response(200, payload(1, 3))).mockResolvedValueOnce(response(403));
    browserApi.mockImplementation(async (url) => ({
      status: 200,
      payload: payload(Number(new URL(url).searchParams.get('pag')), 3),
    }));
    const results = await complete(run(MAP, {}));
    expect(results.map((row) => row.realEstate.id)).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(browserApi.mock.calls.map(([url]) => new URL(url).searchParams.get('pag'))).toEqual(['2', '3']);
  });

  it('uses the same fallback for a translated town search', async () => {
    fetch.mockResolvedValue(response(403));
    browserApi.mockResolvedValue({ status: 200, payload: payload(1) });
    expect(await complete(run('https://www.immobiliare.it/vendita-case/milano/', {}))).toHaveLength(1);
    const url = new URL(browserApi.mock.calls[0][0]);
    expect(url.searchParams.get('path')).toBe('/vendita-case/milano/');
    expect(url.searchParams.get('idComune')).toBe('8042');
  });

  it('keeps successful API requests on their original transport', async () => {
    fetch.mockResolvedValue(response(200, payload(1)));
    expect(await complete(run(MAP, {}))).toHaveLength(1);
    expect(extract).not.toHaveBeenCalled();
  });

  it('stops on a rate limit without launching the solver', async () => {
    fetch.mockResolvedValue(response(429));
    expect(await complete(run(MAP, {}))).toEqual([]);
    expect(extract).not.toHaveBeenCalled();
  });

  it.each([null, { error: 'blocked' }])(
    'returns no fabricated results for invalid browser API data (%j)',
    async (data) => {
      fetch.mockResolvedValue(response(403));
      browserApi.mockResolvedValue({ status: data == null ? 403 : 200, payload: data });
      expect(await complete(run(MAP, {}))).toEqual([]);
      expect(extract).toHaveBeenCalledOnce();
    },
  );

  it('stops if the browser cannot open the search page', async () => {
    fetch.mockResolvedValue(response(403));
    extract.mockResolvedValue(null);
    expect(await complete(run(MAP, {}))).toEqual([]);
    expect(browserApi).not.toHaveBeenCalled();
  });

  it('does not switch another concurrent job to the browser', async () => {
    let finishBrowser;
    browserApi.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishBrowser = resolve;
        }),
    );
    fetch.mockResolvedValueOnce(response(403)).mockResolvedValueOnce(response(200, payload(2)));
    const first = run(MAP, { name: 'first' });
    await vi.runAllTimersAsync();
    expect(extract).toHaveBeenCalledOnce();
    const second = await run(MAP, { name: 'second' });
    expect(second[0].realEstate.id).toBe(2);
    expect(extract).toHaveBeenCalledOnce();
    finishBrowser({ status: 200, payload: payload(1) });
    expect((await first)[0].realEstate.id).toBe(1);
  });
});
