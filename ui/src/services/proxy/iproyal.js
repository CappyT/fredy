/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * IPRoyal carries its per-request settings in the password, not in the host or the port.
 *
 * A password reads `<password>_country-ch_session-hFtcrtN8_lifetime-5m`: the country the exit node
 * is in, a session id that pins one exit node, and how long that node is held. A password with no
 * suffix rotates: every request leaves from a different address.
 *
 * The suffix is edited here rather than by hand, because a typo in it is silent - IPRoyal answers
 * with a working proxy in the wrong country instead of an error. Everything the form does not know
 * about (a city, a state, `streaming`) is carried through untouched, so a password written by hand
 * survives a save from this page.
 */

/** Where IPRoyal's residential endpoints live. */
const IPROYAL_HOST = 'iproyal.com';

/** Splits a proxy url into its parts, so only the password is rewritten and the rest stays verbatim. */
const PROXY_URL = /^([a-z0-9+.-]+:\/\/)([^:@/]+):([^@/]*)@(.+)$/i;

/** One `key-value` piece of the password suffix. */
const OPTION = /^([a-z]+)-(.*)$/i;

/** The pieces this form owns. Everything else in the password is left where it was. */
const MANAGED = ['country', 'session', 'lifetime'];

/**
 * Is this proxy an IPRoyal one?
 *
 * @param {string} proxyUrl The configured proxy url.
 * @returns {boolean}
 */
export function isIproyalProxy(proxyUrl) {
  const parts = PROXY_URL.exec(String(proxyUrl ?? '').trim());
  if (parts == null) return false;

  try {
    const { hostname } = new URL(`${parts[1]}${parts[4]}`);
    return hostname === IPROYAL_HOST || hostname.endsWith(`.${IPROYAL_HOST}`);
  } catch {
    return false;
  }
}

/**
 * The password, as the segments IPRoyal reads it in.
 *
 * @param {string} password
 * @returns {{base: string, segments: string[]}}
 */
function splitPassword(password) {
  const [base, ...segments] = String(password ?? '').split('_');
  return { base, segments };
}

/** @param {string[]} segments @param {string} key @returns {string|null} The value, or null. */
function valueOf(segments, key) {
  for (const segment of segments) {
    const option = OPTION.exec(segment);
    if (option != null && option[1].toLowerCase() === key) return option[2];
  }
  return null;
}

/**
 * How long a sticky node is held, in minutes.
 *
 * IPRoyal writes the unit into the value. Minutes are what the panel offers and what this form
 * writes back; an hour or a second written by hand is read here rather than thrown away.
 *
 * @param {string|null} lifetime The raw `lifetime` value, e.g. `5m`.
 * @returns {number|null} Minutes, or null when there is no usable value.
 */
function minutesIn(lifetime) {
  const match = /^(\d+)\s*(s|m|h)?$/i.exec(String(lifetime ?? '').trim());
  if (match == null) return null;

  const value = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  if (unit === 'h') return value * 60;
  if (unit === 's') return Math.max(1, Math.round(value / 60));
  return value;
}

/**
 * What the form shows for an IPRoyal proxy url.
 *
 * @param {string} proxyUrl The configured proxy url.
 * @returns {{country: string|null, sticky: boolean, sessionId: string|null, ttlMinutes: number|null}|null}
 *   Null when the url is not an IPRoyal one.
 */
export function readIproyalOptions(proxyUrl) {
  const parts = PROXY_URL.exec(String(proxyUrl ?? '').trim());
  if (parts == null || !isIproyalProxy(proxyUrl)) return null;

  const { segments } = splitPassword(parts[3]);
  const sessionId = valueOf(segments, 'session');

  return {
    country: valueOf(segments, 'country'),
    // The session id is what pins the node. A lifetime without one buys nothing, so the switch
    // follows the session alone.
    sticky: sessionId != null && sessionId.length > 0,
    sessionId,
    ttlMinutes: minutesIn(valueOf(segments, 'lifetime')),
  };
}

/**
 * An id for a sticky session.
 *
 * Any string IPRoyal has not seen before starts a new session, so this only has to be unlikely to
 * collide with the one it replaces.
 *
 * @returns {string} Eight letters and digits.
 */
export function randomSessionId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const values = crypto.getRandomValues(new Uint8Array(8));
  return [...values].map((value) => alphabet[value % alphabet.length]).join('');
}

/**
 * Write the form's choices back into the password.
 *
 * @param {string} proxyUrl The configured proxy url.
 * @param {{country?: string|null, sticky?: boolean, sessionId?: string|null, ttlMinutes?: number|null}} options
 * @returns {string} The proxy url with the new password, or the url unchanged when it is not IPRoyal's.
 */
export function writeIproyalOptions(proxyUrl, options) {
  const parts = PROXY_URL.exec(String(proxyUrl ?? '').trim());
  if (parts == null || !isIproyalProxy(proxyUrl)) return proxyUrl;

  const { base, segments } = splitPassword(parts[3]);
  const wanted = new Map();
  if (options.country) wanted.set('country', String(options.country).toLowerCase());
  if (options.sticky) {
    wanted.set('session', options.sessionId || randomSessionId());
    if (options.ttlMinutes) wanted.set('lifetime', `${options.ttlMinutes}m`);
  }

  // Rewritten in place, so a hand-written password keeps the order it was written in and the
  // pieces this form knows nothing about keep their place among them.
  const kept = segments
    .map((segment) => {
      const option = OPTION.exec(segment);
      const key = option?.[1]?.toLowerCase();
      if (key == null || !MANAGED.includes(key)) return segment;
      if (!wanted.has(key)) return null;

      const value = wanted.get(key);
      wanted.delete(key);
      return `${key}-${value}`;
    })
    .filter((segment) => segment != null);

  const added = [...wanted].map(([key, value]) => `${key}-${value}`);
  return `${parts[1]}${parts[2]}:${[base, ...kept, ...added].join('_')}@${parts[4]}`;
}

/**
 * The countries the configured providers serve, which are the ones worth proxying through.
 *
 * Read off the providers themselves rather than kept as a list here: a provider added to Fredy
 * brings its country with it.
 *
 * @param {Array<{countries?: string[]}>} [providers] The `provider` store slice.
 * @returns {string[]} Sorted alpha-2 codes.
 */
export function countriesFromProviders(providers) {
  const codes = new Set();
  for (const provider of providers ?? []) {
    for (const code of provider?.countries ?? []) {
      if (typeof code === 'string' && /^[a-z]{2}$/i.test(code)) codes.add(code.toLowerCase());
    }
  }
  return [...codes].sort();
}
