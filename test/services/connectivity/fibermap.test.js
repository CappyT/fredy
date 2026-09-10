/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { parseAddress, parseLabel } from '../../../lib/services/connectivity/italianAddress.js';
import { normalizeFibermap, IT_NETWORK_TECHNOLOGIES } from '../../../lib/services/connectivity/normalize.js';

const root = path.resolve('.');
const clientPath = root + '/lib/services/connectivity/client/fibermapClient.js';
const loggerPath = root + '/lib/services/logger.js';

/**
 * One recorded answer of the aggregator.
 *
 * @param {string} name
 * @returns {any}
 */
function fixture(name) {
  return JSON.parse(fs.readFileSync(`${root}/test/testFixtures/${name}.json`, 'utf-8'));
}

/** The address search, asked the whole of "Via Al Poggio 1/X, Ranzanico". */
const ADDRESSES = fixture('fibermap_addresses');
/** The same search asked for "Via Roma 1, Milano", a street Milano does not have. */
const FUZZY = fixture('fibermap_addresses_fuzzy');
/** The streets of Brescia whose name contains Garibaldi. */
const STREETS = fixture('fibermap_streets');
/** One street's own list of door numbers, which is what the street id is exchanged for. */
const CIVICS = fixture('fibermap_civics');
/** A rural verdict: cabinet copper and wireless, no fibre. */
const COVERAGE = fixture('fibermap_coverage');
/** A city verdict: two fibre networks, and a dedicated half that must not be read. */
const COVERAGE_FIBER = fixture('fibermap_coverage_fiber');

/** Every question the client asked, in order, for the client the current case loaded. */
let requests = [];

/**
 * @param {number} status
 * @param {unknown} [body] What the aggregator sends back: an object, which is serialised the way
 *   the plugin would have serialised it, or a string, which is sent verbatim - which is how a case
 *   hands over one of `admin-ajax.php`'s answers that is not JSON at all. The client reads the body
 *   as text and parses it itself, so `text` rather than `json` is what a response has to offer.
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
 * remembered streets and doors - and a case that leaks it would pass or fail on its neighbour.
 *
 * The pacing is mocked away with it. One request a second is a promise made to somebody else's
 * WordPress install, not behaviour worth spending seconds of the suite proving.
 *
 * @param {(asked: {input: string, type: string, label: string}) => Object} service
 * @returns {Promise<Object>} the client module
 */
async function loadClient(service) {
  vi.resetModules();
  requests = [];
  vi.doMock('node-fetch', () => ({
    default: async (url) => {
      const query = new URL(String(url)).searchParams;
      const asked = {
        input: String(query.get('input')),
        type: String(query.get('type')),
        label: String(query.get('label')),
        tipoCliente: String(query.get('tipoCliente')),
      };
      requests.push(asked);
      return service(asked);
    },
  }));
  vi.doMock('p-throttle', () => ({ default: () => (fn) => fn }));
  vi.doMock(loggerPath, () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
  return import(clientPath);
}

/**
 * The aggregator as it answers for Via Al Poggio in Ranzanico, which is a real address.
 *
 * @param {Object} [options]
 * @param {Object} [options.search] What the address search answers.
 * @param {Object} [options.coverage] What the verdict step answers.
 * @returns {(asked: {input: string, type: string}) => Object}
 */
function ranzanico({ search = answer(200, ADDRESSES), coverage = answer(200, COVERAGE) } = {}) {
  return ({ type }) => {
    if (type === 'default') return search;
    if (type === 'building') return coverage;
    return answer(404);
  };
}

/**
 * The aggregator as it answers for Corso Giuseppe Garibaldi in Brescia, where the address search
 * hands back streets and the door number only turns up in the street's own list.
 *
 * @returns {(asked: {input: string, type: string}) => Object}
 */
function brescia() {
  return ({ type }) => {
    if (type === 'default') return answer(200, STREETS);
    if (type === 'street') return answer(200, CIVICS);
    if (type === 'building') return answer(200, COVERAGE_FIBER);
    return answer(404);
  };
}

/**
 * fibermap.it answers per address and reads the wholesale networks rather than a register cell, so
 * what a test can pin without the network is threefold: that the address a listing carries is
 * turned into the question the site's own form asks, that a fuzzy answer is refused rather than
 * taken, and that the verdict is read as what a flat can actually be connected with.
 */
describe('services/connectivity/fibermapClient', () => {
  describe('the address a listing carries', () => {
    it('reads a label the aggregator printed back, whichever end carries the door number', () => {
      // The address search prints the door number behind the street.
      expect(parseLabel('Via Al Poggio 1/X, Ranzanico')).toEqual({
        street: 'Via Al Poggio',
        civic: '1/X',
        town: 'Ranzanico',
      });
      // The street's own list of doors prints it behind the town instead.
      expect(parseLabel('Corso Giuseppe Garibaldi, Brescia 10/B')).toEqual({
        street: 'Corso Giuseppe Garibaldi',
        civic: '10/B',
        town: 'Brescia',
      });
      expect(parseLabel('Via Pola, Milano')).toEqual({ street: 'Via Pola', civic: null, town: 'Milano' });
      expect(parseLabel('Milano')).toBeNull();
    });

    it('asks the search for street, door number and town, the way the form wants them', async () => {
      const client = await loadClient(ranzanico());

      await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio, 1/X, Ranzanico');

      // The portal prints the door number as its own comma part; the form wants it on the street.
      expect(requests[0]).toMatchObject({
        input: 'Via Al Poggio 1/X, Ranzanico',
        type: 'default',
        tipoCliente: 'privato',
      });
    });

    it('has no question to ask for an address that names no town', async () => {
      const client = await loadClient(ranzanico());

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio')).toBeNull();
      expect(requests).toEqual([]);
    });
  });

  describe('the building a verdict is asked about', () => {
    it('resolves an address and its verdict in two requests', async () => {
      const client = await loadClient(ranzanico());

      const connectivity = await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico');

      expect(requests.map((asked) => asked.type)).toEqual(['default', 'building']);
      // The door with the pairing on it, not the plain number sitting next to it in the answer.
      expect(requests[1].input).toBe('380100175085143');
      expect(connectivity?.source).toBe('it-fibermap');
    });

    it('refuses a street the town does not have rather than answering for its neighbour', async () => {
      // Asked for Via Roma in Milano, the search offers Via Giulio Romano, Viale Romagna and Via
      // Quinto Romano. Every one of them is somebody else's address.
      const client = await loadClient(ranzanico({ search: answer(200, FUZZY) }));

      expect(await client.fetchItalianFibermapConnectivity(45.46, 9.19, 'Via Roma 1, Milano')).toBeNull();
      // Nothing was asked for a verdict, which is the point: a fuzzy answer must cost a lookup, not
      // produce a wrong one.
      expect(requests.some((asked) => asked.type === 'building')).toBe(false);
      expect(client.isFibermapPaused()).toBe(false);
    });

    it("falls back to the street's own list of door numbers", async () => {
      const client = await loadClient(brescia());

      const connectivity = await client.fetchItalianFibermapConnectivity(
        45.54,
        10.22,
        'Corso Giuseppe Garibaldi 10/B, Brescia',
      );

      // The search answered with streets, so that answer is the street lookup and is not asked for
      // a second time: search, the street's doors, the verdict.
      expect(requests.map((asked) => asked.type)).toEqual(['default', 'street', 'building']);
      expect(requests[1].input).toBe('38000035352');
      expect(requests[2].input).toBe('380120004860459');
      expect(connectivity?.fiber).toBe(true);
    });

    it('remembers the whole street from the one request that listed it', async () => {
      const client = await loadClient(brescia());

      await client.fetchItalianFibermapConnectivity(45.54, 10.22, 'Corso Giuseppe Garibaldi 10/B, Brescia');
      requests.length = 0;
      const neighbour = await client.fetchItalianFibermapConnectivity(
        45.54,
        10.22,
        'Corso Giuseppe Garibaldi 3/A, Brescia',
      );

      // A portal that is currently full of one street is the case this exists for, and against a
      // service that allows a handful of verdicts per address it is the difference between reading
      // the street and being cut off halfway down it.
      expect(requests.map((asked) => asked.type)).toEqual(['building']);
      expect(requests[0].input).toBe('380100000750247');
      expect(neighbour?.fiber).toBe(true);
    });

    it("answers an address without a door number for the street's first building", async () => {
      const client = await loadClient(brescia());

      const connectivity = await client.fetchItalianFibermapConnectivity(
        45.54,
        10.22,
        'Corso Giuseppe Garibaldi s.n.c, Brescia',
      );

      // Nothing for the address search to narrow, so it is not asked to: the street, its doors,
      // and the first of them.
      expect(requests.map((asked) => asked.type)).toEqual(['default', 'street', 'building']);
      expect(requests[0].input).toBe('Corso Giuseppe Garibaldi, Brescia');
      expect(requests[2].input).toBe('380100000749893');
      expect(connectivity).not.toBeNull();
    });

    it('has no verdict for a street nobody knows', async () => {
      const client = await loadClient(() => answer(200, { status: 'ok', type: 'street', data: [] }));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Nessuna 1, Nessundove')).toBeNull();
      expect(client.isFibermapPaused()).toBe(false);
    });
  });

  describe('the verdict a card is drawn from', () => {
    it('reads the fastest network per technology', () => {
      const connectivity = normalizeFibermap(COVERAGE.data.network);

      // EOLO's wireless is the fastest thing that reaches this house; FiberCop's fibre is listed
      // but answers `stato: 0`, so it is not there at all.
      expect(connectivity?.maxDownMbit).toBe(300);
      expect(connectivity?.fiber).toBe(false);
      expect(connectivity?.technologies).toEqual({
        fttc: { maxDownMbit: 200, sharePercent: null },
        fwa: { maxDownMbit: 300, sharePercent: null },
      });
      expect(connectivity?.sharePercent).toBeNull();
      expect(connectivity?.mobile).toBeNull();
      expect(connectivity?.source).toBe('it-fibermap');
    });

    it('carries the networks that reach the door, fastest first', () => {
      expect(normalizeFibermap(COVERAGE.data.network)?.networks).toEqual([
        'EOLO FWA',
        'FiberCop NGA FTTC',
        'FiberCop Ethernet ADSL',
      ]);
    });

    it('reads both fibre networks at an address that has two', () => {
      const connectivity = normalizeFibermap(COVERAGE_FIBER.data.network);

      expect(connectivity?.maxDownMbit).toBe(2500);
      expect(connectivity?.fiber).toBe(true);
      expect(connectivity?.technologies).toEqual({ ftthb: { maxDownMbit: 2500, sharePercent: null } });
      expect(connectivity?.networks).toEqual([
        'FiberCop NGA FTTH',
        'Open Fiber FTTH Aree Nere A&B',
        'FiberCop Ethernet ADSL',
      ]);
    });

    it('leaves business access out of the verdict', () => {
      // The dedicated half of this answer offers five 1000 Mbit/s lines. Every one of them is a
      // symmetric line quoted per site and built to order, and counting them would tell somebody
      // reading about a flat that they can have a gigabit when what they can have is a quotation.
      expect(COVERAGE_FIBER.data.network.dedicated.RETELIT.speed_dl).toBe(1000);
      expect(normalizeFibermap(COVERAGE_FIBER.data.network)?.networks).not.toContain('Retelit Fibra Premium');
    });

    it('counts copper from the exchange towards the speed without naming it a technology', () => {
      const adslOnly = { shared: { ADSL_FC: { stato: 1, speed_dl: 20, vendibile: 'Attivo', copertura: 'ADSL' } } };
      const connectivity = normalizeFibermap(adslOnly);

      expect(connectivity?.maxDownMbit).toBe(20);
      expect(connectivity?.technologies).toEqual({});
      expect(connectivity?.fiber).toBe(false);
    });

    it('leaves out a network that does not reach the address', () => {
      const network = {
        shared: {
          FTTH_FC: { stato: 0, speed_dl: 1000, vendibile: 'NO', copertura: 'FiberCop NGA FTTH' },
          FTTH_OF_AB: { stato: 1, speed_dl: 1000, vendibile: 'Pianificato', copertura: 'Open Fiber' },
          FTTC_FC: { stato: 1, speed_dl: 0, vendibile: 'Attivo', copertura: 'FiberCop NGA FTTC' },
        },
      };

      const connectivity = normalizeFibermap(network);

      // Planned is not available, and a network with no speed on it says nothing worth storing.
      expect(connectivity?.maxDownMbit).toBeNull();
      expect(connectivity?.fiber).toBe(false);
      expect(connectivity?.networks).toEqual([]);
    });

    it('keeps a saturated line, which is a port question rather than a property of the flat', () => {
      const saturated = {
        shared: { FTTC_FC: { stato: 1, speed_dl: 200, vendibile: 'Saturo', copertura: 'FiberCop NGA FTTC' } },
      };

      expect(normalizeFibermap(saturated)?.maxDownMbit).toBe(200);
    });

    it('reads an unserved address as a verdict and a malformed answer as a gap', () => {
      expect(normalizeFibermap({ shared: {}, dedicated: [] })).toEqual({
        maxDownMbit: null,
        sharePercent: null,
        fiber: false,
        technologies: {},
        networks: [],
        mobile: null,
        source: 'it-fibermap',
      });
      expect(normalizeFibermap(null)).toBeNull();
      expect(normalizeFibermap(undefined)).toBeNull();
    });

    it("maps the network codes onto Fredy's fixed-line vocabulary", () => {
      expect(IT_NETWORK_TECHNOLOGIES).toEqual({
        FTTH: 'ftthb',
        FTTB: 'ftthb',
        FTTC: 'fttc',
        VDSL: 'fttc',
        FWA: 'fwa',
        HFC: 'hfc',
      });
    });
  });

  describe('what stands the aggregator down', () => {
    it('reads a refused address as a miss and keeps asking for the others', async () => {
      const client = await loadClient(() => answer(404));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Nessuna 1, Nessundove')).toBeNull();
      // A single unanswerable address must not cost the sweep its remaining lookups - and, since
      // the listing is stamped either way, would be first in the queue to do it again.
      expect(client.isFibermapPaused()).toBe(false);

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Altra 2, Altrove')).toBeNull();
      expect(requests).toHaveLength(2);
    });

    it('stands down when the service itself is unwell', async () => {
      const client = await loadClient(() => answer(503));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(true);
    });

    it('stands down when the service asks to be left alone', async () => {
      const client = await loadClient(() => answer(429));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(true);
    });

    it('stands down when it is not let in at all', async () => {
      // A WordPress install's most likely gatekeeper is a security plugin or a CDN that decides a
      // scripted user agent is unwelcome and answers 401 or 403 to everything for the next hour.
      // Read as a miss, that hour would stamp every italian listing in the run "unserved".
      const client = await loadClient(() => answer(401));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(true);
    });

    it('stands down when it is refused outright', async () => {
      const client = await loadClient(() => answer(403));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(true);
    });

    it('reads a 200 carrying a bare 0 as one wasted request', async () => {
      // `admin-ajax.php`'s own way of saying the handler declined. The site is up and answering,
      // and standing the source down for an hour over it would be worse than the miss: a paused
      // source leaves the listing unstamped, unstamped listings sort first, and this one reply
      // would come back around to pause the source again on every sweep from here on.
      const client = await loadClient(() => answer(200, '0'));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(false);

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Altra 2, Altrove')).toBeNull();
      expect(requests).toHaveLength(2);
    });

    it('reads a 200 carrying a fragment of html the same way', async () => {
      const client = await loadClient(() => answer(200, '<b>Warning</b>: undefined index in plugin.php on line 42'));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(false);
    });

    it('stands down when the quota has run out', async () => {
      // The measured refusal: five verdicts per address and the sixth comes back like this, with a
      // 200 and a body that says no. It is a 429 in all but name.
      const client = await loadClient(({ type }) =>
        type === 'building' ? answer(200, { status: 'blocked', type: 'coverage' }) : answer(200, ADDRESSES),
      );

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(true);
    });

    it('stands down when nothing comes back at all', async () => {
      const client = await loadClient(() => {
        throw new Error('ECONNRESET');
      });

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      expect(client.isFibermapPaused()).toBe(true);
    });

    it('does not remember a failure as a verdict about the address', async () => {
      let failing = true;
      const client = await loadClient((asked) => (failing ? answer(503) : ranzanico()(asked)));

      expect(await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
      failing = false;
      client.resetFibermapClient();

      // The address is fine, the service was not: asking again has to reach the service rather
      // than a remembered null.
      const connectivity = await client.fetchItalianFibermapConnectivity(45.79, 9.91, 'Via Al Poggio 1/X, Ranzanico');
      expect(connectivity?.maxDownMbit).toBe(300);
    });
  });

  describe('the address a listing carries, as both italian sources read it', () => {
    it('is parsed once and shared, so the two cannot drift apart', () => {
      // The parser lives beside the clients rather than inside one of them. This is the case that
      // sent it there: a door number riding on the street, which both checkers have to lift off.
      expect(parseAddress('Via Al Poggio 1/X, Ranzanico')).toEqual({
        street: 'Via Al Poggio',
        civic: '1/X',
        town: 'Ranzanico',
      });
    });
  });
});
