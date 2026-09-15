/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The DataDome token a protected host wants.
 *
 * A host behind DataDome answers a request without a `datadome` cookie with HTTP 403 and a body that
 * names the challenge. Two shapes have been measured:
 *
 * - a JSON body, `{"url":"https://geo.captcha-delivery.com/captcha/?...&t=fe&..."}` (the website
 *   endpoint of immobiliare.it),
 * - an HTML interstitial, `var dd={...'hsh':...,'t':...,...}` plus a `<script>` on
 *   `captcha-delivery.com` (the pages of idealista.it).
 *
 * The challenge is solved elsewhere and only the cookie is kept, so this module owns two things -
 * reading a challenge out of a blocked answer, and turning one into a cookie through capsolver.
 *
 * Capsolver needs a residential proxy and one of its own user agents, and it refuses a challenge
 * whose `t` is `bv` - that value means the asking IP is the reason for the block, and only a clean
 * IP earns the `fe` challenge it can solve. Both the proxy and the key come from the environment,
 * so a deployment without them keeps the old behaviour: a blocked read is a failed read.
 *
 * This is a fork-only module; see `ITALY.md` for the policy it exists under.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import logger from './logger.js';
import { configFilePath } from '../utils.js';

/** The capsolver service. */
const CAPSOLVER_URL = 'https://api.capsolver.com';

/** The host a DataDome challenge lives on. Its presence is what identifies a block. */
const CHALLENGE_HOST = 'captcha-delivery.com';

/** The one task capsolver offers for DataDome, slider and interstitial alike. */
const TASK_TYPE = 'DatadomeSliderTask';

/**
 * The user agent capsolver accepts for a DataDome task. It answers only the fixed set it ships
 * (Chrome 137 to 151), so a caller that wants a token for a browser has to make the browser use
 * this one too: DataDome binds the cookie to the user agent that earned it.
 */
export const SOLVE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** How long a solve may take, and how often its progress is asked for. */
const SOLVE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The cookies solved so far, by host, each with the moment it stops being usable.
 *
 * A DataDome cookie lives a year (`Max-Age=31536000`), so a run rarely solves the same host twice.
 * The map is written to disk - see {@link persist} - so a restart does not pay for a solve it
 * already bought, which is the whole point: a solve costs money, and the portal accepts the cookie
 * until it expires or the endpoint refuses it again.
 *
 * @type {Map<string, {cookie: string, expires: number}>}
 */
const tokens = new Map();

/** Whether the on-disk store has been read into {@link tokens} yet. */
let hydrated = false;

/**
 * The file the tokens are kept in: beside the sqlite database, on the same volume, so a container
 * restart keeps them. `FREDY_DATADOME_STORE` overrides it, which is what the tests use.
 *
 * The directory is resolved the way the database path is (`SqliteConnection.computeDbPath`): the
 * configured `sqlitepath` is read as a directory relative to the project root when it does not
 * describe an absolute one, and `/db` is the default.
 *
 * @returns {string} the absolute path of the store file
 */
function storeFile() {
  if (process.env.FREDY_DATADOME_STORE) return process.env.FREDY_DATADOME_STORE;

  let rawDir = '/db';
  try {
    const cfg = JSON.parse(readFileSync(configFilePath(), 'utf8'));
    if (typeof cfg?.sqlitepath === 'string' && cfg.sqlitepath.length > 0) rawDir = cfg.sqlitepath;
  } catch {
    // No readable config yet: the database would fall back to `/db` too, so this does the same.
  }
  const relative = rawDir.startsWith('/') ? rawDir.slice(1) : rawDir;
  const absolute = isAbsolute(relative) ? relative : join(process.cwd(), relative);
  return join(absolute, 'datadome-tokens.json');
}

/** Read the store into {@link tokens}, once per process. */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const saved = JSON.parse(readFileSync(storeFile(), 'utf8'));
    const now = Date.now();
    for (const [host, entry] of Object.entries(saved)) {
      if (typeof entry?.cookie === 'string' && Number(entry?.expires) > now) {
        tokens.set(host, { cookie: entry.cookie, expires: Number(entry.expires) });
      }
    }
  } catch {
    // No store yet, or an unreadable one. Either way there is nothing to restore.
  }
}

/** Write {@link tokens} back to the store. A failure only costs a future solve, never the run. */
function persist() {
  try {
    const file = storeFile();
    mkdirSync(dirname(file), { recursive: true });
    const out = {};
    for (const [host, entry] of tokens) out[host] = entry;
    writeFileSync(file, JSON.stringify(out, null, 2));
  } catch (error) {
    logger.debug(`DataDome: the token store could not be written (${error?.message ?? error}).`);
  }
}

/**
 * Whether a response is DataDome refusing the request.
 *
 * Only a 403 can be one, and the body has to name the challenge host: DataDome answers a plain
 * block as `{"url": "https://geo.captcha-delivery.com/captcha/?..."}` or as an HTML interstitial
 * whose script sits on the same host, and this is what tells that apart from an ordinary 403 the
 * portal might send for another reason.
 *
 * @param {number} status the response status
 * @param {string} body the response body
 * @returns {boolean}
 */
export function isDataDomeBlock(status, body) {
  return status === 403 && typeof body === 'string' && body.includes(CHALLENGE_HOST);
}

/**
 * Read the challenge url out of a blocked JSON response.
 *
 * @param {string} body the body of a blocked response
 * @returns {string|null} the challenge url, or null when the body is not the shape that carries one
 */
function captchaUrlInJson(body) {
  try {
    const url = JSON.parse(body)?.url;
    return typeof url === 'string' && url.includes(CHALLENGE_HOST) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Rebuild the challenge url out of the HTML interstitial.
 *
 * The interstitial carries a `dd` object with the fields the challenge url is made of - the client
 * id, the client key (`hsh`), the challenge type, the two counters and the challenge host - rather
 * than the finished url. Rebuilding it is best effort: the fields move between DataDome versions,
 * and a shape this does not recognise answers null, which leaves the block unsolved rather than
 * sending capsolver a wrong url.
 *
 * @param {string} body the body of a blocked response
 * @returns {string|null} the challenge url, or null when it could not be built
 */
function captchaUrlInHtml(body) {
  const field = (name) => body.match(new RegExp(`['"]${name}['"]\\s*:\\s*['"]([^'"]+)['"]`))?.[1] ?? null;
  const host = body.match(/https?:\/\/([a-z0-9.-]*captcha-delivery\.com)/i)?.[1] ?? 'geo.captcha-delivery.com';
  const cid = field('cid');
  const hsh = field('hsh');
  const type = field('t');
  const s = field('s');
  const e = field('e');
  if (cid == null || hsh == null || type == null) return null;

  const url = new URL(`https://${host}/captcha/`);
  url.searchParams.set('initialCid', cid);
  url.searchParams.set('cid', cid);
  url.searchParams.set('hash', hsh);
  url.searchParams.set('t', type);
  if (s != null) url.searchParams.set('s', s);
  if (e != null) url.searchParams.set('e', e);
  return url.toString();
}

/**
 * Read the challenge url out of a blocked response, whichever of the two shapes it is.
 *
 * @param {string} body the body of a blocked response
 * @returns {string|null} the challenge url, or null when it could not be read
 */
export function captchaUrlIn(body) {
  return captchaUrlInJson(body) ?? captchaUrlInHtml(body);
}

/**
 * Whether capsolver can solve a challenge.
 *
 * It answers only the `fe` challenge. A `bv` challenge means the asking IP is blocked and is the
 * reason for the block, and no cookie solves that - the IP has to change.
 *
 * @param {string} captchaUrl a DataDome challenge url
 * @returns {boolean}
 */
export function isSolveable(captchaUrl) {
  try {
    return new URL(captchaUrl).searchParams.get('t') === 'fe';
  } catch {
    return false;
  }
}

/**
 * The cookie a capsolver solution carries, as a `Cookie` header value.
 *
 * The solution is the whole `Set-Cookie` line - `datadome=...; Max-Age=...; Domain=...` - while a
 * request wants the name and the value alone.
 *
 * @param {{cookie?: string}|null|undefined} solution the `solution` of a finished task
 * @returns {string|null} `datadome=...`, or null when the solution carries no cookie
 */
export function cookieValue(solution) {
  const cookie = solution?.cookie;
  if (typeof cookie !== 'string') return null;
  const first = cookie.split(';')[0].trim();
  return first.startsWith('datadome=') ? first : null;
}

/**
 * When the cookie of a solution stops being usable, from the `Max-Age` it carries.
 *
 * A solution without a readable `Max-Age` is kept for a day, which is far longer than a run and far
 * shorter than a year: storing it forever would leave a dead cookie in the place a live one
 * belongs.
 *
 * @param {{cookie?: string}|null|undefined} solution the `solution` of a finished task
 * @returns {number} epoch milliseconds
 */
export function cookieExpiry(solution) {
  const seconds = Number(String(solution?.cookie).match(/Max-Age=(\d+)/)?.[1]);
  return Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 24 * 60 * 60 * 1000);
}

/**
 * The token a host was already solved for, when there is one.
 *
 * @param {string} host the host the request goes to (`www.immobiliare.it`)
 * @returns {string|null} the `Cookie` header value, or null when the host has no token yet
 */
export function readToken(host) {
  hydrate();
  const entry = tokens.get(host);
  if (entry == null) return null;
  if (entry.expires <= Date.now()) {
    tokens.delete(host);
    return null;
  }
  return entry.cookie;
}

/**
 * Forget the tokens solved so far, in memory and on disk. Exists for the tests.
 *
 * @returns {void}
 */
export function clearTokens() {
  tokens.clear();
  persist();
}

/**
 * Ask capsolver to solve one challenge and give back the cookie.
 *
 * @param {string} captchaUrl the challenge url a blocked response named
 * @param {{apiKey: string, proxy: string, userAgent: string}} credentials the capsolver key, the
 *   proxy (`host:port:user:pass`) and the user agent the request was made with - capsolver requires
 *   all three, and the user agent has to be the one the site saw
 * @returns {Promise<string|null>} the `datadome=...` cookie, or null when it could not be solved
 */
export async function solveChallenge(captchaUrl, { apiKey, proxy, userAgent }) {
  const created = await capsolver('createTask', {
    clientKey: apiKey,
    task: { type: TASK_TYPE, captchaUrl, userAgent, proxy },
  });
  if (created?.errorId !== 0 || created?.taskId == null) {
    logger.warn(
      `DataDome: capsolver refused the challenge (${created?.errorCode ?? 'unknown'}: ${created?.errorDescription ?? ''})`.trimEnd(),
    );
    return null;
  }

  const deadline = Date.now() + SOLVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const answer = await capsolver('getTaskResult', { clientKey: apiKey, taskId: created.taskId });
    if (answer?.errorId !== 0) {
      logger.warn(`DataDome: capsolver answered an error (${answer?.errorCode ?? 'unknown'}).`);
      return null;
    }
    const cookie = cookieValue(answer.solution);
    if (answer.status === 'ready' && cookie != null) return { cookie, expires: cookieExpiry(answer.solution) };
    if (answer.status === 'ready') {
      logger.warn('DataDome: capsolver solved the challenge without a datadome cookie.');
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  logger.warn('DataDome: capsolver did not finish the challenge in time.');
  return null;
}

/**
 * @param {string} path a capsolver endpoint (`createTask`, `getTaskResult`, `getBalance`)
 * @param {Record<string, any>} payload the request body
 * @returns {Promise<any|null>} the answer, or null when the call itself failed
 */
async function capsolver(path, payload) {
  try {
    const response = await fetch(`${CAPSOLVER_URL}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return await response.json();
  } catch (error) {
    logger.warn(`DataDome: capsolver could not be reached (${error?.message ?? error}).`);
    return null;
  }
}

/**
 * The credentials a solve needs, from the environment.
 *
 * Both are required: capsolver refuses a DataDome task without a proxy. When either is absent the
 * deployment cannot solve, and every caller answers as it did before this module existed.
 *
 * @returns {{apiKey: string, proxy: string}|null}
 */
function credentials() {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  const proxy = process.env.CAPSOLVER_PROXY;
  return apiKey && proxy ? { apiKey, proxy } : null;
}

/**
 * Turn a blocked response into a token for its host, when the deployment can solve it.
 *
 * @param {{status: number, body: string, host: string, userAgent: string}} blocked the refused
 *   answer to a request, its body, the host it was for and the user agent it was made with
 * @returns {Promise<string|null>} the `datadome=...` cookie, or null when no token could be got
 */
export async function tokenForBlock({ status, body, host, userAgent }) {
  const creds = credentials();
  if (creds == null) return null;
  if (!isDataDomeBlock(status, body)) return null;

  const captchaUrl = captchaUrlIn(body);
  if (captchaUrl == null || !isSolveable(captchaUrl)) {
    logger.debug('DataDome: the challenge cannot be solved (no captcha url, or a blocked ip).');
    return null;
  }

  const solved = await solveChallenge(captchaUrl, { ...creds, userAgent });
  if (solved != null) {
    tokens.set(host, solved);
    persist();
    return solved.cookie;
  }
  return null;
}

/**
 * The token for a url, asking it once for a challenge when the host has none yet.
 *
 * The token is per host, so a caller that has to hand a cookie to something other than its own
 * `fetch` - a browser page, say - asks this instead of reading the response itself.
 *
 * @param {string} url the protected url
 * @param {string} userAgent the user agent the caller will use for the real request
 * @returns {Promise<string|null>} the `datadome=...` cookie, or null when the host does not block
 *   or the block cannot be solved
 */
export async function tokenForUrl(url, userAgent) {
  const host = new URL(url).host;
  const known = readToken(host);
  if (known != null) return known;
  if (credentials() == null) return null;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    return await tokenForBlock({ status: response.status, body, host, userAgent });
  } catch (error) {
    logger.debug(`DataDome: ${host} could not be asked for a challenge (${error?.message ?? error}).`);
    return null;
  }
}
