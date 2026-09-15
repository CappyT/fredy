/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDataDomeBlock,
  captchaUrlIn,
  isSolveable,
  cookieValue,
  cookieExpiry,
  cookieParts,
  capsolverProxy,
  solveChallenge,
  tokenForBlock,
  tokenForUrl,
  readToken,
  clearTokens,
} from '../../lib/services/datadome.js';

/**
 * The api key and the proxy are read from the global settings, so the settings are what a test sets.
 * Mocked rather than seeded into a database: this suite is about the solver, and a real read would
 * pull sqlite and the config file into every one of its cases.
 */
const storedSettings = vi.hoisted(() => ({ value: {} }));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => storedSettings.value,
}));

/**
 * The DataDome token service. What these tests pin is the reading of the two block shapes that were
 * measured (the JSON one of immobiliare.it and the HTML interstitial of idealista.it), the capsolver
 * exchange, and the on-disk store that keeps a solved cookie across a restart - the part that keeps
 * a solve from being paid for twice. The network is never touched: `fetch` is stubbed.
 */

/** A JSON block, as immobiliare.it's website endpoint answers one. */
const JSON_BLOCK = JSON.stringify({
  url: 'https://geo.captcha-delivery.com/captcha/?initialCid=AHrl&cid=CID&hash=HASH&t=fe&s=52458&e=81046c',
});

/** An HTML interstitial, as idealista.it's pages answer one. */
const HTML_BLOCK =
  "<html><body><p>Please enable JS</p><script data-cfasync='false'>" +
  "var dd={'rt':'c','cid':'CID','hsh':'AC81AADC3279CA4C7B968B717FBB30','t':'fe','qp':'','s':17156,'e':'b3f0','host':'geo.captcha-delivery.com'};" +
  '</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>';

/** The same interstitial for an ip DataDome has flagged, which no cookie can answer. */
const BV_BLOCK = HTML_BLOCK.replace("'t':'fe'", "'t':'bv'");

/**
 * @param {any} body
 * @returns {any} a response-shaped object
 */
function answer(body) {
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
}

describe('reading a DataDome block', () => {
  it('recognises a block by its status and its challenge host', () => {
    expect(isDataDomeBlock(403, JSON_BLOCK)).toBe(true);
    expect(isDataDomeBlock(403, HTML_BLOCK)).toBe(true);
    expect(isDataDomeBlock(200, JSON_BLOCK)).toBe(false);
    expect(isDataDomeBlock(403, '{"error":"nope"}')).toBe(false);
  });

  it('reads the challenge url out of a JSON block', () => {
    expect(captchaUrlIn(JSON_BLOCK)).toContain('geo.captcha-delivery.com/captcha/');
    expect(captchaUrlIn(JSON_BLOCK)).toContain('t=fe');
  });

  it('rebuilds the challenge url out of an HTML interstitial', () => {
    const url = captchaUrlIn(HTML_BLOCK);
    expect(url).toContain('initialCid=CID');
    expect(url).toContain('hash=AC81AADC3279CA4C7B968B717FBB30');
    expect(url).toContain('t=fe');
  });

  it('answers null for a body that carries no challenge', () => {
    expect(captchaUrlIn('<html><body>nothing here</body></html>')).toBeNull();
  });

  it('solves only the fe challenge, never the bv one', () => {
    expect(isSolveable('https://geo.captcha-delivery.com/captcha/?t=fe')).toBe(true);
    expect(isSolveable('https://geo.captcha-delivery.com/captcha/?t=bv')).toBe(false);
  });

  it('keeps the counters of an interstitial, whether they are quoted or not', () => {
    // The measured interstitial writes `'s'` as a bare number and `'e'` as a string. A counter
    // dropped for being a number would leave capsolver with an incomplete challenge url.
    const url = captchaUrlIn(HTML_BLOCK);
    expect(url).toContain('s=17156');
    expect(url).toContain('e=b3f0');
  });

  it('takes the cookie out of a solution and its lifetime from Max-Age', () => {
    const solution = { cookie: 'datadome=ABC; Max-Age=3600; Domain=.immobiliare.it; Path=/; Secure' };
    expect(cookieValue(solution)).toBe('datadome=ABC');
    expect(cookieExpiry(solution)).toBeGreaterThan(Date.now() + 3_500_000);
    expect(cookieValue({ cookie: 'session=x' })).toBeNull();
  });

  it('reads the lifetime whatever the case of Max-Age, and keeps an unstated one to a day', () => {
    expect(cookieExpiry({ cookie: 'datadome=ABC; max-age=3600' })).toBeGreaterThan(Date.now() + 3_500_000);
    const unstated = cookieExpiry({ cookie: 'datadome=ABC; Domain=.immobiliare.it' });
    expect(unstated).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(unstated).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
  });

  it('splits a cookie on its first = so that base64 padding survives', () => {
    expect(cookieParts('datadome=A1+b2/c3==')).toEqual({ name: 'datadome', value: 'A1+b2/c3==' });
  });
});

describe('the proxy capsolver is given', () => {
  it('rewrites the configured url into capsolver notation', () => {
    expect(capsolverProxy('http://user:pass@geo.iproyal.com:12321')).toBe('geo.iproyal.com:12321:user:pass');
  });

  it('decodes what the url escaped', () => {
    expect(capsolverProxy('http://user:p%40ss%3Aword@geo.example:8080')).toBe('geo.example:8080:user:p@ss:word');
  });

  it('carries a proxy that needs no credentials', () => {
    expect(capsolverProxy('http://geo.example:8080')).toBe('geo.example:8080');
  });

  it('has nothing to give without a proxy, a port, or a url at all', () => {
    expect(capsolverProxy('')).toBe(null);
    expect(capsolverProxy('http://geo.example')).toBe(null);
    expect(capsolverProxy('not a url')).toBe(null);
  });
});

describe('solving a challenge through capsolver', () => {
  /** @type {string} */
  let dir;
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'datadome-'));
    process.env.FREDY_DATADOME_STORE = join(dir, 'datadome-tokens.json');
    process.env.CAPSOLVER_API_KEY = 'test-key';
    // The one proxy the deployment has. Capsolver is sent this, rewritten into its own notation.
    storedSettings.value = { proxyUrl: 'http://user:pass@geo.example:1234' };
    clearTokens();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.FREDY_DATADOME_STORE;
    delete process.env.CAPSOLVER_API_KEY;
    storedSettings.value = {};
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @param {{create?: any, result?: any}} tasks what capsolver answers at each step
   * @returns {any} a fetch replacement routing by capsolver endpoint
   */
  function capsolverFetch({ create, result }) {
    return vi.fn(async (url) => {
      const target = String(url);
      if (target.endsWith('/createTask')) return answer(create);
      if (target.endsWith('/getTaskResult')) return answer(result);
      throw new Error(`unexpected fetch: ${target}`);
    });
  }

  /** @returns {number} how many solves the stubbed capsolver was asked to pay for */
  function createTasks() {
    return globalThis.fetch.mock.calls.filter(([url]) => String(url).endsWith('/createTask')).length;
  }

  const created = JSON.stringify({ errorId: 0, status: 'idle', taskId: 'task-1' });
  const ready = JSON.stringify({
    errorId: 0,
    status: 'ready',
    solution: { cookie: 'datadome=SOLVED; Max-Age=31536000; Domain=.immobiliare.it; Path=/; Secure' },
  });

  it('turns a challenge into a cookie', async () => {
    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    const solved = await solveChallenge(captchaUrlIn(JSON_BLOCK), {
      apiKey: 'test-key',
      proxy: 'p',
      userAgent: 'ua',
    });
    expect(solved.cookie).toBe('datadome=SOLVED');
    expect(solved.expires).toBeGreaterThan(Date.now());
  });

  it('answers null when capsolver refuses the task', async () => {
    globalThis.fetch = capsolverFetch({
      create: JSON.stringify({
        errorId: 1,
        errorCode: 'ERROR_INVALID_TASK_DATA',
        errorDescription: 'proxy is required',
      }),
    });
    const solved = await solveChallenge(captchaUrlIn(JSON_BLOCK), { apiKey: 'test-key', proxy: '', userAgent: 'ua' });
    expect(solved).toBeNull();
  });

  it('solves a block and keeps the cookie, on disk, across a restart', async () => {
    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    const cookie = await tokenForBlock({
      status: 403,
      body: JSON_BLOCK,
      host: 'www.immobiliare.it',
      userAgent: 'ua',
    });
    expect(cookie).toBe('datadome=SOLVED');
    expect(readToken('www.immobiliare.it')).toBe('datadome=SOLVED');
    expect(existsSync(join(dir, 'datadome-tokens.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'datadome-tokens.json'), 'utf8'))['www.immobiliare.it'].cookie).toBe(
      'datadome=SOLVED',
    );

    vi.resetModules();
    const fresh = await import('../../lib/services/datadome.js');
    expect(fresh.readToken('www.immobiliare.it')).toBe('datadome=SOLVED');
  });

  it('does not solve when the deployment has no credentials', async () => {
    delete process.env.CAPSOLVER_API_KEY;
    globalThis.fetch = vi.fn();
    const cookie = await tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'x', userAgent: 'ua' });
    expect(cookie).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not solve when there is no proxy, because capsolver refuses the task without one', async () => {
    storedSettings.value = {};
    globalThis.fetch = vi.fn();
    const cookie = await tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'x', userAgent: 'ua' });
    expect(cookie).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('prefers the api key from the settings page and sends the configured proxy', async () => {
    delete process.env.CAPSOLVER_API_KEY;
    storedSettings.value = { capsolverApiKey: ' from-the-page ', proxyUrl: 'http://user:pass@geo.example:1234' };
    globalThis.fetch = capsolverFetch({ create: created, result: ready });

    await tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' });

    const [, options] = globalThis.fetch.mock.calls.find(([url]) => String(url).endsWith('/createTask'));
    const sent = JSON.parse(options.body);
    expect(sent.clientKey).toBe('from-the-page');
    expect(sent.task.proxy).toBe('geo.example:1234:user:pass');
  });

  it('gives a browser the token by asking the url once when the host is unknown', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.endsWith('/createTask')) return answer(created);
      if (target.endsWith('/getTaskResult')) return answer(ready);
      // the protected page itself: a block naming the challenge
      return { ok: false, status: 403, text: async () => HTML_BLOCK, json: async () => ({}) };
    });
    const cookie = await tokenForUrl('https://www.idealista.it/vendita-case/milano/', 'ua');
    expect(cookie).toBe('datadome=SOLVED');
    expect(readToken('www.idealista.it')).toBe('datadome=SOLVED');
  });

  it('never pays for a challenge capsolver cannot answer', async () => {
    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    const cookie = await tokenForBlock({ status: 403, body: BV_BLOCK, host: 'www.idealista.it', userAgent: 'ua' });
    expect(cookie).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('buys one solve for a host however often the walk is refused', async () => {
    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    const first = await tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' });
    expect(first).toBe('datadome=SOLVED');

    // The solved cookie is refused in turn, on every one of the twenty pages a search walks.
    for (let page = 2; page <= 20; page++) {
      const again = await tokenForBlock({
        status: 403,
        body: JSON_BLOCK,
        host: 'www.immobiliare.it',
        userAgent: 'ua',
        usedToken: first,
      });
      expect(again).toBeNull();
    }
    expect(createTasks()).toBe(1);
  });

  it('hands back the cookie another caller solved rather than buying a second', async () => {
    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    await tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' });
    const answered = await tokenForBlock({
      status: 403,
      body: JSON_BLOCK,
      host: 'www.immobiliare.it',
      userAgent: 'ua',
      usedToken: 'datadome=STALE',
    });
    expect(answered).toBe('datadome=SOLVED');
    expect(createTasks()).toBe(1);
  });

  it('solves once when two jobs are refused at the same moment', async () => {
    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    const both = await Promise.all([
      tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' }),
      tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' }),
    ]);
    expect(both).toEqual(['datadome=SOLVED', 'datadome=SOLVED']);
    expect(createTasks()).toBe(1);
  });

  it('keeps nothing from a solution that carries no cookie', async () => {
    globalThis.fetch = capsolverFetch({
      create: created,
      result: JSON.stringify({ errorId: 0, status: 'ready', solution: {} }),
    });
    const cookie = await tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' });
    expect(cookie).toBeNull();
    expect(readToken('www.immobiliare.it')).toBeNull();
  });

  it('waits for a task that is not ready yet, and gives up on one that never is', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      globalThis.fetch = vi.fn(async (url) => {
        if (String(url).endsWith('/createTask')) return answer(created);
        polls += 1;
        return answer(polls === 1 ? JSON.stringify({ errorId: 0, status: 'processing' }) : ready);
      });
      const solving = solveChallenge(captchaUrlIn(JSON_BLOCK), { apiKey: 'test-key', proxy: 'p', userAgent: 'ua' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await solving).cookie).toBe('datadome=SOLVED');

      globalThis.fetch = capsolverFetch({
        create: created,
        result: JSON.stringify({ errorId: 0, status: 'processing' }),
      });
      const never = solveChallenge(captchaUrlIn(JSON_BLOCK), { apiKey: 'test-key', proxy: 'p', userAgent: 'ua' });
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await never).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the cookie of another host when it writes a new one', async () => {
    const store = join(dir, 'datadome-tokens.json');
    const kept = { cookie: 'datadome=KEPT', expires: Date.now() + 3_600_000 };
    writeFileSync(store, JSON.stringify({ 'www.idealista.it': kept }));

    // A fresh module has not read the store yet, which is the moment a write could erase it.
    vi.resetModules();
    const fresh = await import('../../lib/services/datadome.js');
    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    await fresh.tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' });

    const written = JSON.parse(readFileSync(store, 'utf8'));
    expect(Object.keys(written).sort()).toEqual(['www.idealista.it', 'www.immobiliare.it']);
    expect(written['www.idealista.it'].cookie).toBe('datadome=KEPT');
  });

  it('forgets an expired entry instead of keeping it in the store', async () => {
    const store = join(dir, 'datadome-tokens.json');
    writeFileSync(
      store,
      JSON.stringify({ 'old.example.com': { cookie: 'datadome=GONE', expires: Date.now() - 1_000 } }),
    );
    vi.resetModules();
    const fresh = await import('../../lib/services/datadome.js');
    expect(fresh.readToken('old.example.com')).toBeNull();

    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    await fresh.tokenForBlock({ status: 403, body: JSON_BLOCK, host: 'www.immobiliare.it', userAgent: 'ua' });
    expect(Object.keys(JSON.parse(readFileSync(store, 'utf8')))).toEqual(['www.immobiliare.it']);
  });

  it('reads a store that cannot be parsed as an empty one, and writes a good one over it', async () => {
    const store = join(dir, 'datadome-tokens.json');
    writeFileSync(store, '{"www.immobiliare.it": {"cookie": "datadome=TRUN');
    vi.resetModules();
    const fresh = await import('../../lib/services/datadome.js');
    expect(fresh.readToken('www.immobiliare.it')).toBeNull();

    globalThis.fetch = capsolverFetch({ create: created, result: ready });
    const cookie = await fresh.tokenForBlock({
      status: 403,
      body: JSON_BLOCK,
      host: 'www.immobiliare.it',
      userAgent: 'ua',
    });
    expect(cookie).toBe('datadome=SOLVED');
    expect(JSON.parse(readFileSync(store, 'utf8'))['www.immobiliare.it'].cookie).toBe('datadome=SOLVED');
  });
});
