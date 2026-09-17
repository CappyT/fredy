/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * What a provider that reads through `fetch` does with a DataDome refusal.
 *
 * The guard answers by exit address, so the remedies are ordered by what they cost: another exit
 * node first, the paid solver last. This file pins that order, what each read carries, and the
 * refusal the helper hands back for the caller to report.
 *
 * The proxy is real, because the rotation is the password: `syncOutboundProxy` installs an IPRoyal
 * url and the dispatcher a rotated read is given has to carry a session id that url does not.
 */

/** A sticky IPRoyal proxy: the session id in the password is what pins one exit node. */
const STICKY_PROXY = 'http://user:secret_country-it_session-hFtcrtN8_lifetime-5m@geo.iproyal.com:12321';

/** An IPRoyal proxy with no session segment. It leaves from a new address on every request. */
const ROTATING_PROXY = 'http://user:secret_country-it@geo.iproyal.com:12321';

/** A challenge capsolver answers, and one it refuses because the exit address is what is blocked. */
const FE_BLOCK = JSON.stringify({
  url: 'https://geo.captcha-delivery.com/captcha/?initialCid=AHrl&cid=CID&hash=HASH&t=fe&s=52458&e=81046c',
});
const BV_BLOCK = JSON.stringify({
  url: 'https://geo.captcha-delivery.com/captcha/?initialCid=AHrl&cid=CID&hash=HASH&t=bv&s=52458&e=81046c',
});

/** What the endpoint answers a read it lets through. */
const PAYLOAD = JSON.stringify({ results: [{ id: 1 }] });

const solver = vi.hoisted(() => ({
  tokenForBlock: vi.fn(async () => null),
  readToken: vi.fn(() => null),
}));
vi.mock('../../../lib/services/datadome.js', async (importOriginal) => ({
  ...(await importOriginal()),
  tokenForBlock: solver.tokenForBlock,
  readToken: solver.readToken,
}));

const { readThroughGuard } = await import('../../../lib/services/http/guardedRead.js');
const { syncOutboundProxy, resetOutboundProxyForTests } = await import('../../../lib/services/http/outboundProxy.js');
const { default: logger } = await import('../../../lib/services/logger.js');

/**
 * The proxy url a dispatcher was built from.
 *
 * undici keeps it on a private symbol, which is the only place a test can read it back. A rename
 * upstream fails these tests rather than passing them on a dispatcher that rotated nothing.
 *
 * @param {any} dispatcher
 * @returns {string|null}
 */
function proxyUrlOf(dispatcher) {
  for (const key of Object.getOwnPropertySymbols(dispatcher)) {
    const value = dispatcher[key];
    if (value != null && typeof value === 'object' && typeof value.uri === 'string') return value.uri;
  }
  return null;
}

/** The password segment that pins one IPRoyal exit node. */
const sessionIn = (url) => /_session-([^_@]*)/.exec(url ?? '')?.[1] ?? null;

/**
 * Read a scripted endpoint through the guard, with the pauses between the reads skipped.
 *
 * @param {Array<{status: number, body: string}>} script what the endpoint answers, read by read
 * @param {{proxyUrl?: string, solve?: boolean}} [options]
 * @returns {Promise<{answer: any, reads: any[]}>} the answer the helper hands back, and how each
 *   read was made: the cookie it carried, and the dispatcher it left through
 */
async function readGuarded(script, { proxyUrl = STICKY_PROXY, solve = true } = {}) {
  const reads = [];
  syncOutboundProxy({ proxyUrl }, {});

  const send = async ({ cookie, dispatcher }) => {
    reads.push({ cookie, dispatcher, proxy: dispatcher == null ? null : proxyUrlOf(dispatcher) });
    const answer = script[reads.length - 1] ?? script[script.length - 1];
    return {
      status: answer.status,
      statusText: answer.status === 403 ? 'Forbidden' : 'OK',
      text: async () => answer.body,
    };
  };

  vi.useFakeTimers();
  try {
    const running = readThroughGuard({ host: 'api.example.it', name: 'Portal', page: 1, solve, send });
    await vi.runAllTimersAsync();
    return { answer: await running, reads };
  } finally {
    vi.useRealTimers();
  }
}

describe('reading an endpoint behind the guard', () => {
  /** @type {import('vitest').MockInstance} */
  let warnings;

  beforeEach(() => {
    solver.tokenForBlock.mockReset().mockResolvedValue(null);
    solver.readToken.mockReset().mockReturnValue(null);
    warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetOutboundProxyForTests();
    vi.restoreAllMocks();
  });

  /**
   * The challenge follows the exit address, so the first remedy is the cheap one: ask again from a
   * node the proxy has not used. The dispatcher that carries it is closed once its answer is read,
   * because it holds an agent and a walk refused on every page would otherwise leave twenty behind.
   */
  it('reads again through a dispatcher that leaves from another exit, and closes it', async () => {
    const { answer, reads } = await readGuarded([
      { status: 403, body: FE_BLOCK },
      { status: 200, body: PAYLOAD },
    ]);

    expect(answer).toMatchObject({ ok: true, status: 200, body: PAYLOAD });
    expect(reads).toHaveLength(2);

    expect(reads[0].dispatcher).toBe(null);
    expect(sessionIn(reads[1].proxy)).not.toBe(null);
    expect(sessionIn(reads[1].proxy)).not.toBe('hFtcrtN8');
    expect(reads[1].dispatcher.closed).toBe(true);
    expect(solver.tokenForBlock).not.toHaveBeenCalled();
  });

  /**
   * Three rotations are the whole of the cheap remedy. Only then is a solve paid for, and the read
   * carrying the cookie goes back to the configured exit, which is the address that earned it.
   */
  it('pays for a cookie once every exit was refused, and presents it from the configured exit', async () => {
    solver.tokenForBlock.mockResolvedValue('datadome=SOLVED');

    const { answer, reads } = await readGuarded([
      { status: 403, body: FE_BLOCK },
      { status: 403, body: FE_BLOCK },
      { status: 403, body: FE_BLOCK },
      { status: 403, body: FE_BLOCK },
      { status: 200, body: PAYLOAD },
    ]);

    expect(answer.ok).toBe(true);
    expect(reads).toHaveLength(5);
    expect(solver.tokenForBlock).toHaveBeenCalledTimes(1);
    expect(solver.tokenForBlock.mock.calls[0][0]).toMatchObject({ status: 403, host: 'api.example.it' });

    for (const read of reads.slice(1, 4)) expect(sessionIn(read.proxy)).not.toBe('hFtcrtN8');
    expect(reads[4]).toMatchObject({ cookie: 'datadome=SOLVED', dispatcher: null });
  });

  /**
   * Nothing is left once the solver declines: no key, a cooldown, a challenge it will not take. The
   * refusal goes back whole, because what to do with a read that failed is the caller's to decide
   * and its body is the only evidence it has.
   */
  it('hands the refusal back when the solver has nothing to give', async () => {
    const { answer, reads } = await readGuarded([{ status: 403, body: FE_BLOCK }]);

    expect(answer).toMatchObject({ ok: false, status: 403, statusText: 'Forbidden', body: FE_BLOCK });
    expect(reads).toHaveLength(4);
    expect(solver.tokenForBlock).toHaveBeenCalledTimes(1);
  });

  /** A `bv` challenge names the address as the reason, and capsolver refuses it. Only exits help. */
  it('spends no solve on a challenge that names the exit address', async () => {
    const { answer, reads } = await readGuarded([{ status: 403, body: BV_BLOCK }]);

    expect(answer.status).toBe(403);
    expect(reads).toHaveLength(4);
    expect(reads.slice(1).every((read) => read.dispatcher != null)).toBe(true);
    expect(solver.tokenForBlock).not.toHaveBeenCalled();
    expect(warnings.mock.calls.join('\n')).toContain('DataDome bv, not solvable');
  });

  /**
   * Without a proxy there is one address, and asking it again is the whole of the remedy. The line
   * says so, because a refusal that no rotation can answer is a proxy that has to be configured.
   */
  it('asks once more and says the exit could not be rotated when there is no proxy', async () => {
    solver.tokenForBlock.mockResolvedValue('datadome=SOLVED');

    const { reads } = await readGuarded(
      [
        { status: 403, body: FE_BLOCK },
        { status: 403, body: FE_BLOCK },
        { status: 200, body: PAYLOAD },
      ],
      { proxyUrl: '' },
    );

    expect(reads).toHaveLength(3);
    expect(reads.every((read) => read.dispatcher == null)).toBe(true);
    expect(warnings.mock.calls.join('\n')).toContain('the exit could not be rotated');
    // The second read is all the rotation there was, so the solve follows it at once.
    expect(solver.tokenForBlock).toHaveBeenCalledTimes(1);
  });

  /**
   * An IPRoyal password with no session segment already leaves from a new address per request, so
   * the installed dispatcher is the rotation and nothing is built for it.
   */
  it('rotates without a dispatcher when the password carries no session', async () => {
    const { reads } = await readGuarded(
      [
        { status: 403, body: FE_BLOCK },
        { status: 200, body: PAYLOAD },
      ],
      { proxyUrl: ROTATING_PROXY },
    );

    expect(reads).toHaveLength(2);
    expect(reads[1].dispatcher).toBe(null);
    expect(warnings.mock.calls.join('\n')).toContain('Reading it again from another exit.');
  });

  /**
   * A refusal the guard did not write is the endpoint judging what it was sent, and it answers the
   * same from every address. Rotating for it would only delay what the caller does instead.
   */
  it('spends no extra request on a refusal that is not the guard', async () => {
    const plain = await readGuarded([{ status: 403, body: 'Forbidden by the edge' }]);
    expect(plain.reads).toHaveLength(1);
    expect(plain.answer.status).toBe(403);

    const unprocessable = await readGuarded([{ status: 422, body: JSON.stringify({ errors: ['bad search'] }) }]);
    expect(unprocessable.reads).toHaveLength(1);
    expect(unprocessable.answer).toMatchObject({ ok: false, status: 422 });

    expect(solver.tokenForBlock).not.toHaveBeenCalled();
  });

  /**
   * A host that is never solved for is not read with a cookie either, and a `fe` challenge on it is
   * not bought back. The exits are still worth trying: they cost a request, not money.
   */
  it('rotates but buys nothing for a host the caller does not solve for', async () => {
    solver.readToken.mockReturnValue('datadome=STORED');

    const { reads } = await readGuarded([{ status: 403, body: FE_BLOCK }], { solve: false });

    expect(reads).toHaveLength(4);
    expect(reads.every((read) => read.cookie == null)).toBe(true);
    expect(solver.readToken).not.toHaveBeenCalled();
    expect(solver.tokenForBlock).not.toHaveBeenCalled();
  });

  /**
   * A cookie already paid for costs nothing to present, and one solved from another exit node is
   * accepted, so it rides the rotated reads as well.
   */
  it('carries a cookie the host was already solved for on every read', async () => {
    solver.readToken.mockReturnValue('datadome=STORED');

    const { reads } = await readGuarded([
      { status: 403, body: FE_BLOCK },
      { status: 200, body: PAYLOAD },
    ]);

    expect(reads.map((read) => read.cookie)).toEqual(['datadome=STORED', 'datadome=STORED']);
  });
});
