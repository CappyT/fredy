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

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import logger from './logger.js';
import { configFilePath } from '../utils.js';
import { getSettings } from './storage/settingsStorage.js';
import { resolveProxyUrl } from './proxyUrl.js';

/** The capsolver service. */
const CAPSOLVER_URL = 'https://api.capsolver.com';

/** The host a DataDome challenge lives on. Its presence is what identifies a block. */
const CHALLENGE_HOST = 'captcha-delivery.com';

/** The one task capsolver offers for DataDome, slider and interstitial alike. */
const TASK_TYPE = 'DatadomeSliderTask';

/**
 * The user agent capsolver accepts for a DataDome task. It answers only the fixed set it ships
 * (Chrome 137 to 151).
 *
 * The cookie is not bound to the agent that earned it. Measured on `api.homegate.ch`: one cookie
 * minted under this agent answered HTTP 200 with real listings on three consecutive requests that
 * carried, in turn, this agent, `homegate.ch.nextgen App Android/13.3.0` and a Firefox 131 agent.
 * A caller therefore does not have to make its browser wear this one.
 *
 * The agent still has to look like a browser or an app. The fourth request of that run carried
 * `curl/8.9.1` and was refused 403 with the same cookie, and that cookie was refused on every
 * later request, from its own exit address as well.
 */
export const SOLVE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** How long a solve may take, and how often its progress is asked for. */
const SOLVE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How long a host waits before it may be solved for again.
 *
 * A solve is paid for, and a refusal repeats: a search walks twenty pages, and a token the endpoint
 * does not accept would buy twenty solves in a minute, once per page, and again for every job that
 * runs meanwhile. One attempt per host per cooldown is the cap. The cost of it is one failed read
 * until the next run, against an unbounded bill.
 */
const SOLVE_COOLDOWN_MS = 10 * 60 * 1000;

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
 * When each host was last asked for a solve, whether it earned a cookie or not. Read against
 * {@link SOLVE_COOLDOWN_MS}, which is what keeps a repeated refusal from being paid for repeatedly.
 *
 * @type {Map<string, number>}
 */
const attempts = new Map();

/**
 * The solve each host has running, so that two jobs meeting the same block buy one cookie between
 * them rather than one each.
 *
 * @type {Map<string, Promise<string|null>>}
 */
const inFlight = new Map();

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
    if (saved == null || typeof saved !== 'object' || Array.isArray(saved)) return;
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

/**
 * Write {@link tokens} back to the store. A failure only costs a future solve, never the run.
 *
 * Written to a temporary file and renamed into place, the way `updateConfigOnDisk` writes the
 * config: a crash or a second process writing at the same moment would otherwise leave a truncated
 * file, and a store that cannot be parsed is every cookie in it paid for again.
 */
function persist() {
  try {
    const file = storeFile();
    mkdirSync(dirname(file), { recursive: true });
    const now = Date.now();
    const out = {};
    for (const [host, entry] of tokens) {
      if (entry.expires <= now) tokens.delete(host);
      else out[host] = entry;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(out, null, 2));
    renameSync(temporary, file);
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
  // A value is a quoted string or a bare number - the measured interstitial carries `'s':17156`
  // unquoted - and a counter dropped for being a number leaves an incomplete challenge url behind.
  const field = (name) => {
    const found = body.match(new RegExp(`['"]${name}['"]\\s*:\\s*(?:['"]([^'"]*)['"]|(\\d+))`));
    return found?.[1] ?? found?.[2] ?? null;
  };
  const host = body.match(/https?:\/\/([a-z0-9.-]*captcha-delivery\.com)/i)?.[1] ?? 'geo.captcha-delivery.com';
  const cid = field('cid');
  const hsh = field('hsh');
  const type = field('t');
  const s = field('s');
  const e = field('e');
  if (!cid || !hsh || !type) return null;

  const url = new URL(`https://${host}/captcha/`);
  url.searchParams.set('initialCid', cid);
  url.searchParams.set('cid', cid);
  url.searchParams.set('hash', hsh);
  url.searchParams.set('t', type);
  if (s) url.searchParams.set('s', s);
  if (e) url.searchParams.set('e', e);
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
 * Name the challenge a blocked body carries, for the line that reports the refusal.
 *
 * The body alone does not show it: `t` sits at the end of a url far longer than any log line keeps,
 * so a truncated body hides the one field that says what to do next. The two kinds want opposite
 * remedies. `fe` is the kind capsolver solves, so the read can be bought back; `bv` and `it` mean
 * the asking address is what is refused, and only another exit helps.
 *
 * @param {string} body the body of a blocked response
 * @returns {string} a ` (DataDome <kind>, <verdict>)` suffix, or an empty string when the body names
 *   no challenge
 */
export function describeChallenge(body) {
  const challenge = captchaUrlIn(body);
  if (challenge == null) return '';

  try {
    const kind = new URL(challenge).searchParams.get('t');
    return ` (DataDome ${kind}, ${isSolveable(challenge) ? 'solvable' : 'not solvable, the exit ip is refused'})`;
  } catch {
    return '';
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
 * A `name=value` cookie split into its two halves.
 *
 * Split on the first `=` only: a DataDome value is base64 and ends in `=` padding often enough that
 * splitting on every one of them hands a browser a truncated cookie, which the portal then refuses.
 *
 * @param {string} cookie a `Cookie` header value holding one cookie
 * @returns {{name: string, value: string}}
 */
export function cookieParts(cookie) {
  const at = cookie.indexOf('=');
  return at < 0 ? { name: cookie, value: '' } : { name: cookie.slice(0, at), value: cookie.slice(at + 1) };
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
  const seconds = Number(String(solution?.cookie ?? '').match(/max-age=(\d+)/i)?.[1]);
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
  attempts.clear();
  inFlight.clear();
  // Memory is now what the store says, so a later read must not restore what was just forgotten.
  hydrated = true;
  persist();
}

/**
 * Ask capsolver to solve one challenge and give back the cookie.
 *
 * @param {string} captchaUrl the challenge url a blocked response named
 * @param {{apiKey: string, proxy: string, userAgent: string}} credentials the capsolver key, the
 *   proxy (`host:port:user:pass`) and the user agent the request was made with - capsolver requires
 *   all three, and the user agent has to be the one the site saw
 * @returns {Promise<{cookie: string, expires: number}|null>} the cookie and the moment it stops
 *   being usable, or null when the challenge could not be solved
 */
export async function solveChallenge(captchaUrl, { apiKey, proxy, userAgent }) {
  const created = await capsolver('createTask', {
    clientKey: apiKey,
    task: { type: TASK_TYPE, captchaUrl, userAgent, proxy },
  });
  if (created == null) return null;
  if (created.errorId !== 0 || created.taskId == null) {
    logger.warn(
      redact(
        `DataDome: capsolver refused the challenge (${created.errorCode ?? 'unknown'}: ${created.errorDescription ?? ''})`.trimEnd(),
        [apiKey, proxy],
      ),
    );
    return null;
  }

  const deadline = Date.now() + SOLVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const answer = await capsolver('getTaskResult', { clientKey: apiKey, taskId: created.taskId });
    // The task exists and is being paid for, so a call that did not arrive is asked again until the
    // deadline rather than abandoned. An answer that names an error is final.
    if (answer == null) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }
    if (answer.errorId !== 0) {
      logger.warn(redact(`DataDome: capsolver answered an error (${answer.errorCode ?? 'unknown'}).`, [apiKey, proxy]));
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
 * A message with the deployment's own secrets taken out of it.
 *
 * Capsolver quotes what it was sent back at the caller - an invalid proxy is named in the error it
 * answers - and these lines reach the debug log storage, and from there the debug bundle a user
 * attaches to a bug report.
 *
 * @param {string} text the message about to be logged
 * @param {Array<string|undefined>} secrets the values that may not appear in it
 * @returns {string}
 */
function redact(text, secrets) {
  return secrets.reduce((out, secret) => (secret ? out.split(secret).join('[redacted]') : out), String(text));
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
 * The proxy, written the way capsolver reads one.
 *
 * Capsolver takes `host:port:user:pass`, not a url. It reads it as an HTTP proxy, so a socks-only
 * proxy cannot be used for a solve even though the scrape itself goes through it.
 *
 * @param {string} proxyUrl the configured proxy url
 * @returns {string|null} the proxy for a capsolver task, or null when there is none to give
 */
export function capsolverProxy(proxyUrl) {
  if (!proxyUrl) return null;

  try {
    const { hostname, port, username, password } = new URL(proxyUrl);
    if (!hostname || !port) return null;
    const credentials = username ? `:${decodeURIComponent(username)}:${decodeURIComponent(password)}` : '';
    return `${hostname}:${port}${credentials}`;
  } catch {
    return null;
  }
}

/**
 * The credentials a solve needs.
 *
 * The api key is the admin setting, or `CAPSOLVER_API_KEY` for a deployment that keeps it in its
 * secret store. The proxy is the one Fredy already scrapes through, because capsolver refuses a
 * DataDome task without one and a second proxy would be a second bill for the same job. When either
 * is missing the deployment cannot solve, and every caller answers as it did before this module
 * existed.
 *
 * @returns {Promise<{apiKey: string, proxy: string}|null>}
 */
async function credentials() {
  const settings = await getSettings().catch(() => null);
  const configured = typeof settings?.capsolverApiKey === 'string' ? settings.capsolverApiKey.trim() : '';
  const apiKey = configured || process.env.CAPSOLVER_API_KEY;
  const proxy = capsolverProxy(resolveProxyUrl(settings));
  return apiKey && proxy ? { apiKey, proxy } : null;
}

/**
 * Turn a blocked response into a token for its host, when the deployment can solve it.
 *
 * A solve is paid for, so one is bought only when nothing cheaper is left: a cookie another caller
 * solved meanwhile is handed back instead, a host attempted within {@link SOLVE_COOLDOWN_MS} is
 * refused, and two callers refused at the same moment share the one solve between them.
 *
 * @param {{status: number, body: string, host: string, userAgent: string, usedToken?: string|null}}
 *   blocked the refused answer to a request, its body, the host it was for, the user agent it was
 *   made with, and the token that request carried, when it carried one
 * @returns {Promise<string|null>} the `datadome=...` cookie, or null when no token could be got
 */
export async function tokenForBlock({ status, body, host, userAgent, usedToken = null }) {
  const creds = await credentials();
  if (creds == null) return null;
  if (!isDataDomeBlock(status, body)) return null;

  hydrate();
  const running = inFlight.get(host);
  if (running != null) return await running;

  // A cookie solved while the refused request was in the air is not the one that was refused, so it
  // is worth trying before another is paid for.
  const known = readToken(host);
  if (known != null && known !== usedToken) return known;

  if (Date.now() - (attempts.get(host) ?? 0) < SOLVE_COOLDOWN_MS) {
    logger.debug(`DataDome: ${host} was asked of capsolver recently. The read stays refused.`);
    return null;
  }
  attempts.set(host, Date.now());

  const captchaUrl = captchaUrlIn(body);
  if (captchaUrl == null || !isSolveable(captchaUrl)) {
    logger.debug('DataDome: the challenge cannot be solved (no captcha url, or a blocked ip).');
    return null;
  }

  const solve = solveChallenge(captchaUrl, { ...creds, userAgent })
    .then((solved) => {
      if (solved == null) return null;
      tokens.set(host, solved);
      persist();
      return solved.cookie;
    })
    .catch((error) => {
      logger.warn(`DataDome: the solve for ${host} ended in an error (${error?.message ?? error}).`);
      return null;
    })
    .finally(() => inFlight.delete(host));
  inFlight.set(host, solve);
  return await solve;
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
  if ((await credentials()) == null) return null;
  // Nothing would be solved within the cooldown, so the host is not asked for a challenge either:
  // a portal whose challenge cannot be solved would otherwise be probed once per search page.
  if (Date.now() - (attempts.get(host) ?? 0) < SOLVE_COOLDOWN_MS) return null;

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
