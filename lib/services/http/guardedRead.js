/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * What a provider does with a DataDome refusal when it reads through `fetch`.
 *
 * The guard answers 403 and names a challenge whose kind depends on the exit address the request
 * left from: measured on the api hosts of Immobiliare.it, Homegate and ImmoScout24.ch, the same
 * request is answered listings from one residential exit and a challenge from another. A refusal
 * therefore has two remedies, tried in that order because of what they cost:
 *
 * 1. another exit node, up to {@link ROTATED_READS} times. It costs one request, and it is the only
 *    remedy for `bv` and `it`, where the address itself is what is refused.
 * 2. a cookie from the solver, once, for a `fe` challenge. It costs money, so `tokenForBlock` caps
 *    it, and only a caller that says so may buy one.
 *
 * Both are for the guard alone. Any other refusal is the endpoint judging what it was sent, and it
 * stands whatever address asks, so it goes back to the caller untouched and ends the read at once.
 *
 * The browser path does the same thing in the run's browser, see `requestApiPage` in
 * `lib/provider/immobiliare.js`. This is the half for the providers that have no browser.
 */

import { sleep } from '../../utils.js';
import {
  captchaUrlIn,
  describeChallenge,
  isDataDomeBlock,
  isSolveable,
  readToken,
  tokenForBlock,
  SOLVE_USER_AGENT,
} from '../datadome.js';
import { canRotateExit, rotatedExitDispatcher } from './outboundProxy.js';
import logger from '../logger.js';

/** How many times a refused read is asked again from another exit before a solve is paid for. */
const ROTATED_READS = 3;

/**
 * How many times a refused read is asked again when the exit cannot be changed.
 *
 * Asking the same address again buys nothing the guard has not already decided, so it is asked once
 * - a refusal is not always about the address - and the remedy stops there.
 */
const PLAIN_READS = 1;

/**
 * The pause between two reads. The new exit answers at once; this only keeps a refused walk from
 * asking twice in the same instant.
 */
const READ_RETRY_MS = 2_000;

/**
 * @typedef {Object} GuardedAnswer
 * @property {boolean} ok whether the endpoint answered the read
 * @property {number} status the status of the last answer
 * @property {string} statusText its reason phrase
 * @property {string} body its body, read once and handed over, so the caller can report it
 */

/**
 * One read, with its body taken out of it and its dispatcher closed.
 *
 * The body is read here because it is wanted three times - by the guard, by the log line and by the
 * caller reporting the refusal - and a `Response` body can be read once. Buffering it is also what
 * lets a rotated dispatcher be closed: it holds its connections open until the request it carried
 * has been read to the end.
 *
 * @param {(read: {cookie: string|null, dispatcher: import('undici').Dispatcher|null}) => Promise<Response>} send
 * @param {{cookie: string|null, dispatcher: import('undici').Dispatcher|null}} read
 * @returns {Promise<GuardedAnswer>}
 */
async function readOnce(send, read) {
  try {
    const response = await send(read);
    const body = await response.text().catch(() => '');
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText ?? '',
      body,
    };
  } finally {
    await read.dispatcher?.close().catch(() => {});
  }
}

/**
 * Read a guarded endpoint, answering a DataDome refusal with the remedies it has.
 *
 * The answer is handed back whatever it says: a read that nothing could rescue is the caller's to
 * report, because only the caller knows what it was reading and what it does instead.
 *
 * @param {Object} options
 * @param {string} options.host the host of the endpoint, for the token store and the solve
 * @param {string} options.name what the provider calls itself in the log
 * @param {(read: {cookie: string|null, dispatcher: import('undici').Dispatcher|null}) => Promise<Response>}
 *   options.send make one request, carrying the cookie and leaving through the dispatcher it is
 *   given. A null dispatcher means the installed one, which is the configured proxy.
 * @param {boolean} [options.solve] whether a `fe` challenge on this host may be bought back. False
 *   for a host that is never solved for, which is then not read with a stored cookie either.
 * @param {number|null} [options.page] the page of the walk being read, for the log line.
 * @returns {Promise<GuardedAnswer>} the last answer the endpoint gave.
 */
export async function readThroughGuard({ host, name, send, solve = true, page = null }) {
  // A cookie already solved for this host costs nothing to present, so the first read carries it.
  const stored = solve ? readToken(host) : null;
  const rotates = canRotateExit();
  let read = { cookie: stored, dispatcher: null };
  let solverAsked = false;

  for (let refusals = 0; ; refusals++) {
    const answer = await readOnce(send, read);
    if (answer.ok || !isDataDomeBlock(answer.status, answer.body)) return answer;

    const where = page == null ? '' : ` on page ${page} of the walk`;
    const refusal =
      `${name} answered ${answer.status}${describeChallenge(answer.body)}${where} from ${host}: ` +
      answer.body.slice(0, 300);

    if (refusals < (rotates ? ROTATED_READS : PLAIN_READS)) {
      logger.warn(
        `${refusal.trimEnd()} ${rotates ? 'Reading it again from another exit.' : 'Reading it again; the exit could not be rotated.'}`,
      );
      await sleep(READ_RETRY_MS);
      // The cookie rides along: one solved from another exit node is accepted, so only the address
      // changes between these reads.
      read = { cookie: stored, dispatcher: rotates ? rotatedExitDispatcher() : null };
      continue;
    }

    // Every exit was refused. Only a `fe` challenge can be bought back, and only once here; the
    // cooldown inside `tokenForBlock` is what keeps a walk of twenty pages to one solve. The cookie
    // is presented from the configured exit, which is the address that earned it.
    const challenge = captchaUrlIn(answer.body);
    if (solve && !solverAsked && challenge != null && isSolveable(challenge)) {
      solverAsked = true;
      logger.warn(`${refusal.trimEnd()} Asking the solver for a cookie.`);
      const solved = await tokenForBlock({
        status: answer.status,
        body: answer.body,
        host,
        userAgent: SOLVE_USER_AGENT,
        usedToken: stored,
      });
      if (solved != null) {
        read = { cookie: solved, dispatcher: null };
        continue;
      }
    }

    return answer;
  }
}
