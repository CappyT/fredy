/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * What Immobiliare.it's website endpoint does to a browser that it refuses.
 *
 * The endpoint is read inside the run's browser, and production 2026-09-17 answers that browser 403
 * with a `fe` challenge from some residential exits and the listings from others. The remedies are
 * ordered by cost - another exit node first, the paid solver last - and this file pins that order,
 * the credentials each read leaves from, and the one ERROR that ends a read nothing could rescue.
 *
 * The run's browser is a stub, but the credentials are not: `launchBrowser` remembers the proxy url
 * and `newIsolatedPage` rewrites it, so a rotated read really carries a password IPRoyal has not
 * seen. This file therefore keeps away from the offline fixture harness in `test/utils.js`, whose
 * browser stub replaces exactly that.
 */

/** A sticky IPRoyal proxy: the session id in the password is what pins one exit node. */
const STICKY_PROXY = 'http://user:secret_country-it_session-hFtcrtN8_lifetime-5m@geo.iproyal.com:12321';

/** A map search, which the provider reads straight from the endpoint without rendering a page. */
const MAP_SEARCH_URL = 'https://www.immobiliare.it/search-list/?idContratto=1&vrt=45.1%2C9.1%3B45.2%2C9.2';

/** A 403 naming the challenge capsolver answers. */
const FE_BLOCK = JSON.stringify({
  url: 'https://geo.captcha-delivery.com/captcha/?initialCid=AHrl&cid=CID&hash=HASH&t=fe&s=52458&e=81046c',
});

/** One page of listings, as the endpoint answers a read it lets through. */
const LISTINGS = JSON.stringify({ maxPages: 1, results: [{ realEstate: { id: 1 } }] });

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));
vi.mock('cloakbrowser/puppeteer', () => ({ launch: launchMock }));

// The api key and the proxy are read from the global settings; a real read would pull sqlite and
// the config file into a suite that is about the browser path alone.
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({ getSettings: async () => ({}) }));

// The app api answers first when it can, and it cannot express this search. Its refusal is what
// sends the provider to the browser, which is the path under test.
vi.mock('../../lib/services/immobiliare/appApi.js', () => ({
  getAppListings: async () => null,
  normalizeAppListing: (item) => item,
}));

const solver = vi.hoisted(() => ({
  tokenForBlock: vi.fn(async () => null),
  readToken: vi.fn(() => null),
}));
vi.mock('../../lib/services/datadome.js', async (importOriginal) => ({
  ...(await importOriginal()),
  tokenForBlock: solver.tokenForBlock,
  readToken: solver.readToken,
}));

const provider = await import('../../lib/provider/immobiliare.js');
const { launchBrowser } = await import('../../lib/services/extractor/puppeteerExtractor.js');
const { default: logger } = await import('../../lib/services/logger.js');

/**
 * A browser answering the endpoint from a script, one entry per read, and recording how each read
 * was made: the credentials its context was authenticated with, and the cookies set before it.
 *
 * The address lookup the provider makes after a refusal navigates as well. It is answered apart
 * from the script, so the script stays a list of what the endpoint said.
 *
 * @param {Array<{status: number, body: string}>} script what the endpoint answers, read by read
 * @returns {{browser: any, reads: any[], addressReads: any[]}}
 */
function scriptedBrowser(script) {
  const reads = [];
  const addressReads = [];

  const browser = {
    createBrowserContext: async () => ({
      newPage: async () => {
        const read = { auth: null, cookies: [] };
        return {
          authenticate: async (auth) => {
            read.auth = auth;
          },
          setCookie: async (...cookies) => {
            read.cookies.push(...cookies);
          },
          goto: async (url) => {
            read.url = String(url);
            if (read.url.includes('api.ipify.org')) {
              addressReads.push(read);
              return { status: () => 200, text: async () => JSON.stringify({ ip: '203.0.113.7' }) };
            }
            reads.push(read);
            const answer = script[reads.length - 1] ?? script[script.length - 1];
            return { status: () => answer.status, text: async () => answer.body };
          },
          close: async () => {},
        };
      },
      close: async () => {},
    }),
  };

  return { browser, reads, addressReads };
}

/**
 * Run one search against a scripted endpoint, with the walk's waits skipped.
 *
 * @param {Array<{status: number, body: string}>} script what the endpoint answers, read by read
 * @param {string} [proxyUrl] the proxy the run's browser is launched through
 * @returns {Promise<{listings: any[], reads: any[], addressReads: any[]}>}
 */
async function search(script, proxyUrl = STICKY_PROXY) {
  const { browser, reads, addressReads } = scriptedBrowser(script);
  launchMock.mockResolvedValue(browser);
  const run = provider.createConfig({ url: MAP_SEARCH_URL }, []);

  vi.useFakeTimers();
  try {
    const launched = await launchBrowser(MAP_SEARCH_URL, { proxyUrl });
    const walk = run.getListings(run.url, launched);
    await vi.runAllTimersAsync();
    return { listings: await walk, reads, addressReads };
  } finally {
    vi.useRealTimers();
  }
}

/** The password segment that pins one IPRoyal exit node. */
const sessionIn = (password) => /_session-([^_]*)/.exec(password ?? '')?.[1] ?? null;

describe('#immobiliare refused browser reads', () => {
  /** @type {import('vitest').MockInstance} */
  let errors;

  beforeEach(() => {
    launchMock.mockReset();
    solver.tokenForBlock.mockReset().mockResolvedValue(null);
    solver.readToken.mockReset().mockReturnValue(null);
    errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The challenge follows the exit address, so the first remedy is the cheap one: ask again from a
   * node the proxy has not used. A solvable refusal that a rotation answers is a handled condition
   * and must not be reported as a failure.
   */
  it('reads again from a new exit, and says nothing at ERROR when that works', async () => {
    const { listings, reads, addressReads } = await search([
      { status: 403, body: FE_BLOCK },
      { status: 200, body: LISTINGS },
    ]);

    expect(listings).toHaveLength(1);
    expect(reads).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();

    expect(sessionIn(reads[0].auth.password)).toBe('hFtcrtN8');
    expect(sessionIn(reads[1].auth.password)).not.toBe('hFtcrtN8');
    // The address named in the log has to be the one that was refused, not a third exit node.
    expect(addressReads[0].auth).toEqual(reads[0].auth);
    expect(solver.tokenForBlock).not.toHaveBeenCalled();
  });

  /**
   * Three rotations are the whole of the cheap remedy. Only then is a solve paid for, and the cookie
   * it answers is bound to the address that earned it - the configured exit - so the read carrying
   * it goes back to the credentials the browser was launched with.
   */
  it('pays for a cookie once every exit was refused, and presents it from the configured exit', async () => {
    solver.tokenForBlock.mockResolvedValue('datadome=SOLVED');

    const { listings, reads } = await search([
      { status: 403, body: FE_BLOCK },
      { status: 403, body: FE_BLOCK },
      { status: 403, body: FE_BLOCK },
      { status: 403, body: FE_BLOCK },
      { status: 200, body: LISTINGS },
    ]);

    expect(listings).toHaveLength(1);
    expect(reads).toHaveLength(5);
    expect(errors).not.toHaveBeenCalled();

    expect(solver.tokenForBlock).toHaveBeenCalledTimes(1);
    expect(solver.tokenForBlock.mock.calls[0][0]).toMatchObject({ status: 403, host: 'www.immobiliare.it' });

    for (const read of reads.slice(1, 4)) expect(sessionIn(read.auth.password)).not.toBe('hFtcrtN8');
    expect(reads[4].auth.password).toBe('secret_country-it_session-hFtcrtN8_lifetime-5m');
    expect(reads[4].cookies).toEqual([
      { name: 'datadome', value: 'SOLVED', domain: '.immobiliare.it', path: '/', secure: true },
    ]);
    expect(reads.slice(0, 4).every((read) => read.cookies.length === 0)).toBe(true);
  });

  /** A cookie already paid for costs nothing to present, so it rides the very first read. */
  it('carries a cookie the host was already solved for on the first read', async () => {
    solver.readToken.mockReturnValue('datadome=STORED');

    const { reads } = await search([{ status: 200, body: LISTINGS }]);

    expect(reads[0].cookies).toEqual([
      { name: 'datadome', value: 'STORED', domain: '.immobiliare.it', path: '/', secure: true },
    ]);
  });

  /**
   * Nothing is left once the solver declines: no key, a cooldown, a challenge it will not take. The
   * read is a failure then, and it is reported once rather than once per remedy that was tried.
   */
  it('ends in one ERROR when the solver hands nothing back', async () => {
    const { listings, reads } = await search([{ status: 403, body: FE_BLOCK }]);

    expect(listings).toEqual([]);
    expect(reads).toHaveLength(4);
    expect(solver.tokenForBlock).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('DataDome fe, solvable');
  });

  /**
   * A 422 is the endpoint reading the parameters it was sent, and it says the same from any
   * address. Rotating four times for it would only delay the fallback that renders the page.
   */
  it('spends no exit on a refusal that is not the guard', async () => {
    const { listings, reads } = await search([
      { status: 422, body: JSON.stringify({ errors: [{ message: 'bad search' }] }) },
    ]);

    expect(listings).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(solver.tokenForBlock).not.toHaveBeenCalled();
  });

  /**
   * Only IPRoyal spells its exit wishes in the password. Another proxy still gets the read asked
   * again - a refusal is not always about the address - but from the one exit it has.
   */
  it('retries a proxy whose exit cannot be steered with the credentials it has', async () => {
    const { listings, reads } = await search(
      [
        { status: 403, body: FE_BLOCK },
        { status: 200, body: LISTINGS },
      ],
      'http://user:secret@proxy.example.com:8080',
    );

    expect(listings).toHaveLength(1);
    expect(reads).toHaveLength(2);
    expect(reads[1].auth).toEqual(reads[0].auth);
    expect(errors).not.toHaveBeenCalled();
  });
});
