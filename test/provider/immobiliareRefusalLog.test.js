/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * What a refused endpoint read says in the log.
 *
 * A refusal is the only evidence a deployment gets, and it arrives once in a while rather than on
 * demand, so the line has to carry everything the next investigation needs. The body alone does
 * not: `t` sits at the end of a url longer than any log line keeps, and nothing in the body says
 * which page was refused, how long the browser had been reading, or the address it read from.
 *
 * These are the assertions that keep that line from rotting, because a healthy run never executes
 * the branch that writes it.
 */

/** The page the stub browser answers with, set per test. */
let answer = { status: 403, body: '' };

/** The addresses `exitAddress` is answered with, in order. */
let exitBody = JSON.stringify({ ip: '203.0.113.47' });

vi.mock('../../lib/services/extractor/puppeteerExtractor.js', () => ({
  default: {},
  newIsolatedPage: async () => ({
    page: {
      goto: async (url) => {
        const target = String(url);
        // The address lookup goes through the same navigation path as a read, so it is told apart
        // by its host rather than by a separate stub.
        if (target.includes('api.ipify.org')) {
          return { status: () => 200, text: async () => exitBody };
        }
        return { status: () => answer.status, text: async () => answer.body };
      },
      close: async () => {},
    },
    context: { close: async () => {} },
  }),
}));

const logged = [];
vi.mock('../../lib/services/logger.js', () => ({
  default: {
    error: (...args) => logged.push(args.join(' ')),
    warn: (...args) => logged.push(args.join(' ')),
    info: () => {},
    debug: () => {},
  },
}));

const provider = await import('../../lib/provider/immobiliare.js');

/** A map search, which is the shape that goes straight to the endpoint. */
const MAP_SEARCH =
  'https://www.immobiliare.it/search-list/?idContratto=2&idCategoria=1&idNazione=IT&fkRegione=laz&idProvincia=RM&idComune=6737&__lang=it';

/** The refusal DataDome answers with, as the live endpoint writes it. */
const blockBody = (kind) =>
  JSON.stringify({
    url: `https://geo.captcha-delivery.com/captcha/?initialCid=AHrl&cid=CID&hash=F366DD7CF4DB76FA9B54F971FAB24F&t=${kind}&s=52458&e=81046c`,
  });

describe('the line a refused endpoint read writes', () => {
  beforeEach(() => {
    logged.length = 0;
    exitBody = JSON.stringify({ ip: '203.0.113.47' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the challenge kind, so a solvable refusal is told from a blocked address', async () => {
    answer = { status: 403, body: blockBody('bv') };
    const cfg = provider.createConfig({ url: MAP_SEARCH }, [], []);

    await cfg.getListings(cfg.url, {});

    const refusal = logged.find((line) => line.includes('answered 403'));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('DataDome bv');
    expect(refusal).toContain('not solvable, the exit ip is refused');
  });

  it('calls an fe challenge solvable, which is the opposite remedy', async () => {
    answer = { status: 403, body: blockBody('fe') };
    const cfg = provider.createConfig({ url: MAP_SEARCH }, [], []);

    await cfg.getListings(cfg.url, {});

    const refusal = logged.find((line) => line.includes('answered 403'));
    expect(refusal).toContain('DataDome fe');
    expect(refusal).toContain('solvable');
    expect(refusal).not.toContain('not solvable');
  });

  it('names the page, the age of the browser and the exit address', async () => {
    answer = { status: 403, body: blockBody('bv') };
    const cfg = provider.createConfig({ url: MAP_SEARCH }, [], []);

    await cfg.getListings(cfg.url, {});

    const refusal = logged.find((line) => line.includes('answered 403'));
    // The page says whether the search was never allowed or died partway through a walk; the age
    // says whether the walk outlived the proxy's exit lifetime; the address says which exit to
    // blame.
    expect(refusal).toMatch(/on page \d+ of the walk/);
    expect(refusal).toMatch(/\d+s into the browser/);
    expect(refusal).toContain('from exit 203.0.113.47');
  });

  it('still reports the refusal when the address cannot be read', async () => {
    answer = { status: 403, body: blockBody('bv') };
    exitBody = 'not json at all';
    const cfg = provider.createConfig({ url: MAP_SEARCH }, [], []);

    await cfg.getListings(cfg.url, {});

    // The address is a convenience. Losing it must not cost the refusal itself.
    const refusal = logged.find((line) => line.includes('answered 403'));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('DataDome bv');
  });

  it('names a refusal that carries no challenge without inventing one', async () => {
    answer = { status: 422, body: JSON.stringify({ errors: [{ message: 'bad search' }] }) };
    const cfg = provider.createConfig({ url: MAP_SEARCH }, [], []);

    await cfg.getListings(cfg.url, {});

    const refusal = logged.find((line) => line.includes('answered 422'));
    expect(refusal).toBeDefined();
    expect(refusal).not.toContain('DataDome');
    expect(refusal).toContain('bad search');
  });
});
