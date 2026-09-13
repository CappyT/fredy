/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';
import { sleep } from '../../../lib/utils.js';
import { solveCaptcha } from '../../../lib/services/datadome/captcha.js';

const CAPTCHA_URL = 'https://geo.captcha-delivery.com/captcha/?initialCid=x&cid=y';
const PAGE_URL = 'https://www.immobiliare.it/vendita-case/erbusco/';

/**
 * A fake of one challenge iframe, with the elements the solver reads. A drag
 * is counted on the press, and `passOnDrag` says how many are refused before
 * the container is marked as passed - which is when the interstitial is
 * reloaded away and the frame leaves the page.
 */
function makeChallenge(passOnDrag = 0) {
  const state = { drags: 0, reloads: 0, passed: false };
  const handle = { boundingBox: async () => ({ x: 100, y: 100, width: 63, height: 40 }) };
  const container = { boundingBox: async () => ({ x: 100, y: 100, width: 280, height: 40 }) };
  const frame = {
    url: () => CAPTCHA_URL,
    detached: false,
    waitForSelector: async () => (state.passed ? null : handle),
    $: async (selector) => {
      if (selector === '.sliderContainer.slider-success') return state.passed ? {} : null;
      if (selector === '.sliderContainer') return container;
      if (selector === '#captcha__reload__button') return { click: async () => void state.reloads++ };
      return null;
    },
  };
  return { frame, state, passOnDrag };
}

/**
 * A fake page carrying the given challenges.
 *
 * `selfClears` decides what a wait for the wall lifting itself sees: a page
 * that reloads on its own (the promise resolves), or one that never does (it
 * rejects at once, the way the real wait would once its window ran out).
 *
 * @param {ReturnType<typeof makeChallenge>[]} challenges the walls on the page
 * @param {{selfClears?: boolean}} [options]
 */
function fakePage(challenges, options = {}) {
  const mainFrame = { url: () => PAGE_URL };
  const mouse = {
    log: [],
    move: async (x, y) => void mouse.log.push({ op: 'move', x, y }),
    down: async () => {
      mouse.log.push({ op: 'down' });
      const current = challenges.find((c) => !c.state.passed);
      if (current == null) return;
      current.state.drags += 1;
      current.state.passed = current.state.drags > current.passOnDrag;
    },
    up: async () => void mouse.log.push({ op: 'up' }),
  };
  const page = {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, ...challenges.filter((c) => !c.state.passed).map((c) => c.frame)],
    mouse,
    waitForNetworkIdle: async () => {},
    waitForNavigation: async () => {
      if (options.selfClears) return { status: () => 200 };
      throw new Error('no navigation happened');
    },
  };
  return { page, mouse };
}

const downs = (mouse) => mouse.log.filter((e) => e.op === 'down').length;
const ups = (mouse) => mouse.log.filter((e) => e.op === 'up').length;
/** The moves of the first drag, from the press that opened it to the release. */
const dragMoves = (mouse) => {
  const open = mouse.log.findIndex((e) => e.op === 'down');
  const close = mouse.log.findIndex((e) => e.op === 'up');
  return mouse.log
    .slice(open, close)
    .filter((e) => e.op === 'move')
    .map((e) => e.x);
};

/** The solver's own waits, cut to nothing so the walks run instantly. */
const fast = {
  frameWaitMs: 5,
  handleWaitMs: 5,
  resultWaitMs: 5,
  resumeWaitMs: 5,
  delayFn: async () => {},
};

describe('solveCaptcha', () => {
  it('leaves a page that was never challenged alone', async () => {
    const mainFrame = { url: () => PAGE_URL };
    const page = {
      mainFrame: () => mainFrame,
      frames: () => [mainFrame],
      mouse: { move: vi.fn(), down: vi.fn(), up: vi.fn() },
      waitForNetworkIdle: async () => {},
      waitForNavigation: async () => {
        throw new Error('no navigation happened');
      },
    };

    const solved = await solveCaptcha(page, fast);

    expect(solved).toBe(false);
    expect(page.mouse.down).not.toHaveBeenCalled();
  });

  it('drags the handle past the end of the track and reports the pass', async () => {
    const challenge = makeChallenge();
    const { page, mouse } = fakePage([challenge]);

    const solved = await solveCaptcha(page, fast);

    expect(solved).toBe(true);
    expect(downs(mouse)).toBe(1);
    expect(ups(mouse)).toBe(1);
    expect(challenge.state.reloads).toBe(0);
    // The track is 280px wide and the handle 63px, so the hand starts on
    // x=131.5 and a full drag runs 217px - released a little past the end,
    // the way the measured hand does it.
    const xs = dragMoves(mouse);
    expect(xs.length).toBeGreaterThan(20);
    expect(Math.max(...xs)).toBeGreaterThan(131.5 + 217);
    expect(xs[xs.length - 1]).toBeGreaterThanOrEqual(131.5 + 217);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(131.5 - 3);
  });

  it('deals a fresh challenge when one is refused, then passes', async () => {
    const challenge = makeChallenge(1);
    const { page, mouse } = fakePage([challenge]);

    const solved = await solveCaptcha(page, fast);

    expect(solved).toBe(true);
    expect(downs(mouse)).toBe(2);
    expect(challenge.state.reloads).toBe(1);
  });

  it('goes around again when the reload is challenged anew', async () => {
    const first = makeChallenge();
    const second = makeChallenge();
    const { page, mouse } = fakePage([first, second]);

    const solved = await solveCaptcha(page, fast);

    expect(solved).toBe(true);
    expect(downs(mouse)).toBe(2);
    expect(first.state.passed).toBe(true);
    expect(second.state.passed).toBe(true);
  });

  it('gives up once the attempts are spent', async () => {
    const challenge = makeChallenge(Number.POSITIVE_INFINITY);
    const { page, mouse } = fakePage([challenge]);

    const solved = await solveCaptcha(page, { ...fast, attempts: 2 });

    expect(solved).toBe(false);
    expect(downs(mouse)).toBe(2);
    expect(challenge.state.reloads).toBe(2);
  });

  it('reports a wall that re-arms after its last round as standing', async () => {
    // More challenges than rounds: the last round clears what it was given,
    // but the reload behind it answers with a fresh one anyway.
    const { page, mouse } = fakePage([makeChallenge(), makeChallenge(), makeChallenge()]);

    const solved = await solveCaptcha(page, { ...fast, rounds: 2 });

    expect(solved).toBe(false);
    expect(downs(mouse)).toBe(2);
  });

  it('waits out a wall that lifts itself on a page that answered 403', async () => {
    const { page, mouse } = fakePage([], { selfClears: true });

    // The reload is the wall clearing itself, so the watch for it has to be
    // armed on the status alone - nothing else on the page says it is walled.
    const solved = await solveCaptcha(page, { ...fast, response: { status: () => 403 } });

    expect(solved).toBe(true);
    expect(downs(mouse)).toBe(0);
  });

  it('waits for settling before accepting a navigation without an HTTP response', async () => {
    const { page } = fakePage([]);
    const events = [];
    page.waitForNavigation = async () => {
      events.push('navigation');
      return null;
    };
    page.waitForNetworkIdle = async () => {
      events.push('settle');
    };

    await expect(solveCaptcha(page, { ...fast, response: { status: () => 403 } })).resolves.toBe(true);
    expect(events).toEqual(['navigation', 'settle']);
  });

  it('rejects a response-free navigation when a challenge appears during settling', async () => {
    const { page } = fakePage([]);
    page.waitForNavigation = async () => null;
    page.waitForNetworkIdle = async () => {
      page.frames = () => [page.mainFrame(), makeChallenge().frame];
    };

    await expect(solveCaptcha(page, { ...fast, response: { status: () => 403 } })).resolves.toBe(false);
  });

  it('reports a wall that neither frames nor reloads as standing', async () => {
    const { page, mouse } = fakePage([]);

    const solved = await solveCaptcha(page, { ...fast, response: { status: () => 403 } });

    expect(solved).toBe(false);
    expect(downs(mouse)).toBe(0);
  });

  it('only probes a page that answered as content, instead of waiting the full window', async () => {
    const { page } = fakePage([]);
    let polls = 0;
    const delayFn = async (ms) => {
      polls += 1;
      await sleep(ms);
    };

    // A 200 has to be looked at - a challenge can ride on one - but the probe
    // is a fraction of a second, not the eight a blocked page may take.
    const solved = await solveCaptcha(page, { delayFn, response: { status: () => 200 } });

    expect(solved).toBe(false);
    expect(polls).toBeLessThanOrEqual(3);
  });
});
