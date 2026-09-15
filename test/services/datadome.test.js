/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDataDomeBlock,
  captchaUrlIn,
  isSolveable,
  cookieValue,
  cookieExpiry,
  solveChallenge,
  tokenForBlock,
  tokenForUrl,
  readToken,
  clearTokens,
} from '../../lib/services/datadome.js';

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

  it('takes the cookie out of a solution and its lifetime from Max-Age', () => {
    const solution = { cookie: 'datadome=ABC; Max-Age=3600; Domain=.immobiliare.it; Path=/; Secure' };
    expect(cookieValue(solution)).toBe('datadome=ABC');
    expect(cookieExpiry(solution)).toBeGreaterThan(Date.now() + 3_500_000);
    expect(cookieValue({ cookie: 'session=x' })).toBeNull();
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
    process.env.CAPSOLVER_PROXY = 'host:1234:user:pass';
    clearTokens();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.FREDY_DATADOME_STORE;
    delete process.env.CAPSOLVER_API_KEY;
    delete process.env.CAPSOLVER_PROXY;
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
});
