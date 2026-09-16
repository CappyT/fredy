/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The headers the Swiss SMG apps put on a request, with a pseudo signature.
 *
 * Homegate and ImmoScout24.ch run the same app code and send the same header set. A request that
 * carries a non-empty `X-App-Id` is answered the real listing; one without it is answered a
 * rewritten copy for about 70 to 80 percent of the calls.
 *
 * The server does not validate the OTP signature, so the values only have to have the app's SHAPE.
 * The real `X-App-Id` is a 26 digit numeric string and the real `X-App-Time` is the device id
 * followed by the time in milliseconds (the app's own fallback when its native library fails), and
 * both are generated fresh per request here. Nothing of the app's key material is reproduced.
 *
 * @module smg/appHeaders
 */

import { randomInt } from 'node:crypto';

/** The device id the app persists and writes into `X-App-Time`. A random value per installation. */
const DEVICE_ID = 'a1c2e4f6078';

/**
 * A 26 digit numeric string: the shape of the app's `X-App-Id`.
 *
 * @returns {string}
 */
function appId() {
  let out = '';
  for (let index = 0; index < 26; index++) out += randomInt(0, 10);
  return out;
}

/**
 * The `X-App-Time` shape the app writes when its native library fails: the device id followed by
 * the current time in milliseconds.
 *
 * @returns {string}
 */
function appTime() {
  return `${DEVICE_ID}${Date.now()}`;
}

/**
 * The headers of one request to a Swiss app API, with a fresh signature per call.
 *
 * @param {{userAgent: string, appVersion: string, language?: string}} app the app's user agent, its
 *   `X-App-Version` and, when the portal wants one, the `Accept-Language`
 * @returns {Record<string, string>} the headers, without `Content-Type`
 */
export function appHeaders({ userAgent, appVersion, language }) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': userAgent,
    'X-App-Version': appVersion,
    'X-App-Id': appId(),
    'X-App-Time': appTime(),
  };
  if (language) headers['Accept-Language'] = language;
  return headers;
}
