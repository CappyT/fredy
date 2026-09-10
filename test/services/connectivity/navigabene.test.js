/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi } from 'vitest';

import { coveragePath } from '../../../lib/services/connectivity/client/navigabeneClient.js';
import { parseAddress } from '../../../lib/services/connectivity/italianAddress.js';
import { normalizeItalian, IT_TECHNOLOGIES } from '../../../lib/services/connectivity/normalize.js';

const root = (await import('node:path')).resolve('.');
const clientPath = root + '/lib/services/connectivity/client/navigabeneClient.js';
const loggerPath = root + '/lib/services/logger.js';

/** Every path the client asked for, in order, for the client the current case loaded. */
let requests = [];

/**
 * @param {number} status
 * @param {unknown} [body] What the service sends back: an object, which is serialised the way the
 *   checker would have serialised it, or a string, which is sent verbatim - which is how a case
 *   hands over a body that is not JSON at all. The client reads the body as text and parses it
 *   itself, so `text` rather than `json` is what a response has to offer.
 * @returns {Object}
 */
const answer = (status, body = {}) => ({
  status,
  statusText: '',
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * A client of its own per case, talking to the given service instead of the real one.
 *
 * Fresh rather than reset, because what is under test is module state - the stand-off, and the
 * remembered towns and streets - and a case that leaks it would pass or fail on its neighbour.
 *
 * @param {(path: string) => Object} service Answers a request path.
 * @returns {Promise<Object>} the client module
 */
async function loadClient(service) {
  vi.resetModules();
  requests = [];
  vi.doMock('node-fetch', () => ({
    default: async (url) => {
      const path = String(url).replace('https://prod01.copertura.contratti.net', '');
      requests.push(path);
      return service(path);
    },
  }));
  vi.doMock(loggerPath, () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
  return import(clientPath);
}

/**
 * The checker as it answers for Via Al Poggio 1/X in Ranzanico, which is a real address and the
 * one that first went wrong.
 *
 * @param {Object} [options]
 * @param {Object} [options.building] What the civic number search answers.
 * @returns {(path: string) => Object}
 */
function ranzanico({ building = answer(200, { results: [{ civico: '1/X', egon: 'BUILDING' }] }) } = {}) {
  return (path) => {
    if (path.startsWith('/copertura/city/'))
      return answer(200, { results: [{ name: 'Ranzanico', istat_code: '016178' }] });
    if (path === '/copertura/street/016178/AL%20POGGIO') {
      return answer(200, { results: [{ particella: 'VIA', strada: 'AL POGGIO', egon: 'STREET', civico: '1' }] });
    }
    if (path.startsWith('/copertura/street/016178/VIA/AL%20POGGIO/')) return building;
    if (path.startsWith('/copertura/get/'))
      return answer(200, { results: [{ technology: 'FTTH', download_speed: 1000 }] });
    return answer(404);
  };
}

/**
 * The Italian coverage checker answers per address, so the work a test can pin without the network
 * is the reading of an address and the reading of its answer - plus the request the verdict is
 * asked in, whose base64 context is what makes the checker quote the address back.
 */
describe('services/connectivity/navigabeneClient', () => {
  describe('the address a listing carries', () => {
    it('reads street, civic number and town', () => {
      expect(parseAddress('Via San Francesco, 3, Chiuduno')).toEqual({
        street: 'Via San Francesco',
        civic: '3',
        town: 'Chiuduno',
      });
      expect(parseAddress('Via Torino, Bolgare')).toEqual({ street: 'Via Torino', civic: null, town: 'Bolgare' });
    });

    it('drops the district that sits between the street and the town', () => {
      expect(parseAddress('Via Tito Vignoli s.n.c, Lorenteggio, Milano')).toEqual({
        street: 'Via Tito Vignoli',
        civic: null,
        town: 'Milano',
      });
    });

    it('lifts a civic number that rides on the street itself', () => {
      expect(parseAddress('Via Al Poggio 1/X, Ranzanico')).toEqual({
        street: 'Via Al Poggio',
        civic: '1/X',
        town: 'Ranzanico',
      });
      expect(parseAddress('Via Roma 12/A, Bergamo')).toEqual({ street: 'Via Roma', civic: '12/A', town: 'Bergamo' });
      expect(parseAddress('Via San Francesco 3, Chiuduno')).toEqual({
        street: 'Via San Francesco',
        civic: '3',
        town: 'Chiuduno',
      });
    });

    it('reads a street whose name a particella also starts, and one that ends in a number', () => {
      // "Belvedere" is on the checker's own list of street prefixes, and a house number that rides
      // on the street is a civic number and not part of the name - a street called "Belvedere 10"
      // exists, and the checker keeps the two apart exactly this way.
      expect(parseAddress('Via Belvedere 10, Bolgare')).toEqual({
        street: 'Via Belvedere',
        civic: '10',
        town: 'Bolgare',
      });
    });

    it('has no answer for an address that names no town', () => {
      expect(parseAddress('Via Torino')).toBeNull();
      expect(parseAddress(undefined)).toBeNull();
      expect(parseAddress('')).toBeNull();
    });
  });

  describe('the request a verdict is asked in', () => {
    it('carries the address the checker itself would assemble', () => {
      const path = coveragePath({
        egon: '380100035940697',
        istat: '016073',
        particella: 'VIA',
        civico: '3',
        strada: 'SAN FRANCESCO',
        town: 'CHIUDUNO',
      });

      expect(path).toContain('/copertura/get/b01fdb33-0011-4158-8f90-3702c74d5fae/380100035940697/016073/');
      const encoded = path.split('/').at(-1);
      const context = JSON.parse(Buffer.from(decodeURIComponent(/** @type {string} */ (encoded)), 'base64').toString());
      expect(context).toEqual({
        particella: 'VIA',
        civico: '3',
        strada: 'SAN FRANCESCO',
        codice_istat: '016073',
        comune: 'CHIUDUNO',
      });
    });
  });

  describe('the answer a verdict is read from', () => {
    it('reads the fastest offer per technology', () => {
      const connectivity = normalizeItalian([
        { technology: 'VDSL', download_speed: 74 },
        { technology: 'EVDSL', download_speed: 102 },
        { technology: 'FTTH', download_speed: 2500 },
        { technology: 'FTTHNB', download_speed: 1000 },
        { technology: 'FWA', download_speed: 30 },
      ]);

      expect(connectivity.maxDownMbit).toBe(2500);
      expect(connectivity.fiber).toBe(true);
      expect(connectivity.technologies).toEqual({
        ftthb: { maxDownMbit: 2500, sharePercent: null },
        fttc: { maxDownMbit: 102, sharePercent: null },
        fwa: { maxDownMbit: 30, sharePercent: null },
      });
      expect(connectivity.source).toBe('it-navigabene');
    });

    it('reads an unserved address as a verdict rather than a gap', () => {
      const connectivity = normalizeItalian([]);

      expect(connectivity.maxDownMbit).toBeNull();
      expect(connectivity.fiber).toBe(false);
      expect(connectivity.technologies).toEqual({});
    });

    it('leaves out what it cannot read', () => {
      expect(normalizeItalian(null).technologies).toEqual({});
      expect(normalizeItalian([{ technology: 'FTTH', download_speed: 0 }]).fiber).toBe(false);
      expect(normalizeItalian([{ technology: 'SONOALTRO', download_speed: 100 }]).technologies).toEqual({});
    });

    it('maps both fibre codes onto the one fibre answer', () => {
      expect(IT_TECHNOLOGIES).toEqual({ FTTH: 'ftthb', FTTHNB: 'ftthb', EVDSL: 'fttc', VDSL: 'fttc', FWA: 'fwa' });
    });
  });

  describe('a civic number with a pairing on it', () => {
    it('asks for the number alone and finds the pairing in the answer', async () => {
      const client = await loadClient(ranzanico());

      const connectivity = await client.fetchItalianConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico');

      // The slash is a path separator to the checker, so "1/X" in the request is a segment too many
      // and comes back 404 for an address that exists.
      expect(requests).toContain('/copertura/street/016178/VIA/AL%20POGGIO/1');
      expect(requests.some((path) => path.includes('/AL%20POGGIO/1/X'))).toBe(false);
      expect(connectivity?.maxDownMbit).toBe(1000);

      // The building the pairing names, not the plain number next to it, and the checker is asked
      // about the door it answered for.
      const verdict = /** @type {string} */ (requests.find((path) => path.startsWith('/copertura/get/')));
      expect(verdict).toContain('/BUILDING/');
      const context = JSON.parse(
        Buffer.from(decodeURIComponent(/** @type {string} */ (verdict.split('/').at(-1))), 'base64').toString(),
      );
      expect(context.civico).toBe('1/X');
    });

    it('takes the bare number when the street does not pair its numbers', async () => {
      const building = answer(200, { results: [{ civico: '1', egon: 'PLAIN' }] });
      const client = await loadClient(ranzanico({ building }));

      await client.fetchItalianConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico');

      expect(requests.find((path) => path.startsWith('/copertura/get/'))).toContain('/PLAIN/');
    });

    it('falls back to the street when the checker will not answer for the number', async () => {
      const client = await loadClient(ranzanico({ building: answer(404) }));

      const connectivity = await client.fetchItalianConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico');

      // The street's own first building still answers, and - the point of the case - the rest of the
      // sweep still has a checker to ask.
      expect(connectivity?.maxDownMbit).toBe(1000);
      expect(requests.find((path) => path.startsWith('/copertura/get/'))).toContain('/STREET/');
      expect(client.isNavigabenePaused()).toBe(false);
    });
  });

  describe('what stands the checker down', () => {
    it('reads a refused address as a miss and keeps asking for the others', async () => {
      const client = await loadClient(() => answer(404));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Nessuna, Nessundove')).toBeNull();
      // A single unanswerable address used to cost the whole sweep its remaining lookups - and,
      // since the listing is stamped either way now, would be first in the queue to do it again.
      expect(client.isNavigabenePaused()).toBe(false);

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(requests).toHaveLength(2);
    });

    it('reads a rejected request as a miss too', async () => {
      const client = await loadClient(() => answer(400));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Nessuna, Nessundove')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(false);
    });

    it('stands down when the service itself is unwell', async () => {
      const client = await loadClient(() => answer(503));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(true);
    });

    it('stands down when it is not let in at all', async () => {
      // There is no key to get wrong here, so a 401 is a front door shut against this
      // installation - a WAF that has taken against the user agent, an operator id retired - and
      // it will answer the same way for every address in the run. Read as a miss, one blocked hour
      // would stamp the whole italian backlog "unserved" for half a year.
      const client = await loadClient(() => answer(401));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(true);
    });

    it('stands down when it is refused outright', async () => {
      const client = await loadClient(() => answer(403));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(true);
    });

    it('reads a 200 that is not JSON as one wasted request', async () => {
      // A frontend's error page, a cache's holding page, a PHP notice: an api host can answer any
      // of them with a 200. The service is plainly answering, so standing the source down over it
      // would cost the sweep every lookup it had left.
      const client = await loadClient(() => answer(200, '<html><body>Attention Required</body></html>'));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(false);

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Nessuna, Nessundove')).toBeNull();
      expect(requests).toHaveLength(2);
    });

    it('reads a 200 carrying a bare 0 the same way', async () => {
      const client = await loadClient(() => answer(200, '0'));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(false);
    });

    it('stands down when the service asks to be left alone', async () => {
      const client = await loadClient(() => answer(429));

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(true);
    });

    it('stands down when nothing comes back at all', async () => {
      const client = await loadClient(() => {
        throw new Error('ECONNRESET');
      });

      expect(await client.fetchItalianConnectivity(45.79, 9.91, 'Via Torino, Bolgare')).toBeNull();
      expect(client.isNavigabenePaused()).toBe(true);
    });
  });
});
