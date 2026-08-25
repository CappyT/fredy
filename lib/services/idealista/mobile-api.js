/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Transport for the idealista android app's JSON API.
 *
 * The app talks to `app.idealista.it` rather than to the website, and that host serves JSON to a
 * plain HTTPS request: no DataDome, no browser, no challenge solver. What it does want is proof
 * that the caller is the app, which is three things - the client key, an app version and a device
 * id in every request, and a signature over the parameters.
 *
 * The signature is an HMAC-SHA256 whose key is the ASCII string `bXBUUW5TODhKdFhENmQyRQ==`. It
 * looks like base64 and is not: the app uses those characters verbatim as the key bytes.
 *
 * The signed message is `seed + method + query + body`, where query and body are each their
 * parameters sorted by name and joined `name=value&name=value`, url-encoded the way
 * `java.net.URLEncoder` does it - space becomes `+`, and `* - _ .` are left alone. `seed` is a
 * fresh UUID per request and travels in a header of its own so the server can rebuild the message.
 *
 * `reverse-engineered-idealista.md` records how all of this was measured, and what else the api
 * takes.
 */

import { createHmac, randomBytes, randomUUID } from 'crypto';
import logger from '../logger.js';

const BASE_URL = 'https://app.idealista.it';
const CLIENT_KEY = '5b85c03c16bbb85d96e232b112ee85dc';
const CLIENT_SECRET = 'idea;andr01d';
const SIGNING_KEY = 'bXBUUW5TODhKdFhENmQyRQ==';
const APP_VERSION = '15.3.0';
const USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 14; Pixel 7 Build/UP1A.231005.007)';

/** Endpoint of the italian catalogue. The api is versioned per country. */
export const SEARCH_PATH = '/api/3.5/it/search';
export const LOCATIONS_PATH = '/api/3.5/it/search/locations';

/** Adverts one response carries at most, whatever `maxItems` asks for. */
export const MAX_ITEMS_PER_PAGE = 50;

/**
 * Identifies this installation to idealista, the way an android id identifies a phone. Any 16 hex
 * characters are accepted; it is minted once per process because the api only asks that it stays
 * the same within a session, and a restart looking like a new install costs nothing.
 */
const DEVICE_ID = randomBytes(8).toString('hex');

/** Refresh this long before the token expires, so a request cannot race its own expiry. */
const TOKEN_MARGIN_MS = 60_000;

/** @type {{value: string, expiresAt: number}|null} */
let token = null;

/** @type {Promise<string>|null} The refresh in flight, so concurrent jobs mint one token, not two. */
let tokenRequest = null;

/**
 * Url-encode one value the way `java.net.URLEncoder.encode(value, "UTF-8")` does.
 *
 * `encodeURIComponent` differs from it in two places, and both change the signature: a space has to
 * become `+` rather than `%20`, and `!`, `'`, `(`, `)` and `~` are escaped rather than kept.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The canonical form of one parameter set: sorted by name, joined, every part encoded.
 *
 * @param {Array<[string, unknown]>} params
 * @returns {string}
 */
function canonicalise(params) {
  return [...params]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`)
    .join('&');
}

/**
 * Sign one request.
 *
 * @param {string} method The http method, uppercase.
 * @param {Array<[string, unknown]>} query
 * @param {Array<[string, unknown]>} body
 * @returns {{seed: string, signature: string}}
 */
export function sign(method, query, body) {
  const seed = randomUUID();
  const message = seed + method + canonicalise(query) + canonicalise(body);
  return { seed, signature: createHmac('sha256', SIGNING_KEY).update(message, 'utf8').digest('hex') };
}

/**
 * @param {Array<[string, unknown]>} params
 * @returns {string} the query string as it is sent, which is not the canonical form it is signed in
 */
function queryString(params) {
  return params.map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&');
}

/**
 * @param {Array<[string, unknown]>} body
 * @returns {string}
 */
function formBody(body) {
  return body.map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`).join('&');
}

/**
 * Fetch a bearer token, which the api hands out to the app itself rather than to a user.
 *
 * @returns {Promise<string>}
 */
async function mintToken() {
  const query = /** @type {Array<[string, unknown]>} */ ([
    ['t', DEVICE_ID],
    ['k', CLIENT_KEY],
  ]);
  const body = /** @type {Array<[string, unknown]>} */ ([
    ['grant_type', 'client_credentials'],
    ['scope', 'write'],
  ]);
  const { seed, signature } = sign('POST', query, body);
  const credentials = Buffer.from(`${formEncode(CLIENT_KEY)}:${formEncode(CLIENT_SECRET)}`).toString('base64');

  const response = await fetch(`${BASE_URL}/api/oauth/token?${queryString(query)}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      app_version: APP_VERSION,
      device_identifier: DEVICE_ID,
      Signature: signature,
      seed,
    },
    body: formBody(body),
  });

  if (!response.ok) {
    throw new Error(`idealista refused a token: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const granted = await response.json();
  if (granted?.access_token == null) {
    throw new Error('idealista answered the token request without a token');
  }

  const lifetime = Number(granted.expires_in) * 1000;
  token = {
    value: granted.access_token,
    expiresAt: Date.now() + (Number.isFinite(lifetime) ? lifetime : 0) - TOKEN_MARGIN_MS,
  };
  return token.value;
}

/**
 * The current token, minting one when there is none left.
 *
 * @returns {Promise<string>}
 */
async function currentToken() {
  if (token != null && token.expiresAt > Date.now()) return token.value;
  tokenRequest ??= mintToken().finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
}

/**
 * Drop the token that is held, so the next call mints a fresh one.
 *
 * @returns {void}
 */
export function forgetToken() {
  token = null;
}

/**
 * Call one endpoint of the api.
 *
 * A rejected token is retried once with a fresh one: a token outlives a job run by hours, so the
 * one held has usually been minted by an earlier run and may have been revoked since.
 *
 * @param {string} path
 * @param {{query?: Array<[string, unknown]>, body?: Array<[string, unknown]>, retryOnUnauthorised?: boolean}} [options]
 * @returns {Promise<any>} the parsed response
 * @throws {Error} when the api answers anything but 2xx
 */
export async function call(path, { query = [], body = [], retryOnUnauthorised = true } = {}) {
  const fullQuery = /** @type {Array<[string, unknown]>} */ ([['t', DEVICE_ID], ['k', CLIENT_KEY], ...query]);
  const { seed, signature } = sign('POST', fullQuery, body);

  const response = await fetch(`${BASE_URL}${path}?${queryString(fullQuery)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await currentToken()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      app_version: APP_VERSION,
      device_identifier: DEVICE_ID,
      Signature: signature,
      seed,
    },
    body: formBody(body),
  });

  if (response.status === 401 && retryOnUnauthorised) {
    logger.debug('Idealista rejected the api token; minting a new one.');
    forgetToken();
    return call(path, { query, body, retryOnUnauthorised: false });
  }

  if (!response.ok) {
    throw new Error(`idealista api ${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  return response.json();
}
