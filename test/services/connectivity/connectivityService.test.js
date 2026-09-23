/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

const root = (await import('node:path')).resolve('.');
const settingsPath = root + '/lib/services/storage/settingsStorage.js';
const germanClientPath = root + '/lib/services/connectivity/client/breitbandatlasClient.js';
const swissClientPath = root + '/lib/services/connectivity/client/geoAdminClient.js';
const italianClientPath = root + '/lib/services/connectivity/client/navigabeneClient.js';
const fibermapClientPath = root + '/lib/services/connectivity/client/fibermapClient.js';
const loggerPath = root + '/lib/services/logger.js';

let state;

async function loadService() {
  vi.resetModules();
  vi.doMock(settingsPath, () => ({ getSettings: async () => state.settings }));
  vi.doMock(germanClientPath, () => ({
    fetchGermanConnectivity: async (lat, lng) => {
      state.germanCalls.push([lat, lng]);
      return state.germanAnswer;
    },
    isBreitbandatlasPaused: () => state.germanPaused,
  }));
  vi.doMock(swissClientPath, () => ({
    fetchSwissConnectivity: async (lat, lng) => {
      state.swissCalls.push([lat, lng]);
      return state.swissAnswer;
    },
    isGeoAdminPaused: () => state.swissPaused,
  }));
  vi.doMock(italianClientPath, () => ({
    fetchItalianConnectivity: async (lat, lng, address) => {
      state.italianCalls.push(address);
      return state.italianAnswer;
    },
    isNavigabenePaused: () => state.italianPaused,
  }));
  vi.doMock(fibermapClientPath, () => ({
    fetchItalianFibermapConnectivity: async (lat, lng, address) => {
      state.fibermapCalls.push(address);
      return state.fibermapAnswer;
    },
    isFibermapPaused: () => state.fibermapPaused,
  }));
  vi.doMock(loggerPath, () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
  return import(root + '/lib/services/connectivity/connectivityService.js');
}

/**
 * The one door into the connectivity feature.
 *
 * Everything asserted here is a promise made to somebody else's public service: that a switched-off
 * feature sends nothing at all, that a street full of listings costs one lookup, and that a service
 * having a bad day produces an empty card rather than a broken sweep.
 */
describe('services/connectivity/connectivityService', () => {
  beforeEach(() => {
    state = {
      settings: { connectivityEnabled: true },
      germanCalls: [],
      swissCalls: [],
      germanAnswer: { maxDownMbit: 1000, fiber: true, mobile: null, source: 'de-bba' },
      swissAnswer: { maxDownMbit: 100, fiber: false, mobile: null, source: 'ch-bakom' },
      italianCalls: [],
      italianAnswer: { maxDownMbit: 1000, fiber: true, mobile: null, source: 'it-navigabene' },
      fibermapCalls: [],
      fibermapAnswer: { maxDownMbit: 2500, fiber: true, mobile: null, source: 'it-fibermap' },
      germanPaused: false,
      swissPaused: false,
      italianPaused: false,
      fibermapPaused: false,
    };
  });

  it('asks the register that covers the country the listing is in', async () => {
    const service = await loadService();

    expect((await service.getConnectivity(52.52, 13.405, ['de'])).sourceId).toBe('de-bba');
    expect((await service.getConnectivity(47.37, 8.54, ['ch'])).sourceId).toBe('ch-bakom');
    expect(state.germanCalls).toHaveLength(1);
    expect(state.swissCalls).toHaveLength(1);
  });

  it('sends nothing at all while the feature is switched off', async () => {
    state.settings = { connectivityEnabled: false };
    const service = await loadService();

    expect(await service.getConnectivity(52.52, 13.405, ['de'])).toBeNull();
    // The assertion that matters is not the null - it is that no request left the process. A sweep
    // already in flight when the operator flips the switch has to stop, not finish its batch.
    expect(state.germanCalls).toEqual([]);
  });

  it('leaves a register alone once the operator has switched that one off', async () => {
    state.settings = { connectivityEnabled: true, connectivitySources: { 'de-bba': false } };
    const service = await loadService();

    expect(await service.getConnectivity(52.52, 13.405, ['de'])).toBeNull();
    expect(state.germanCalls).toEqual([]);
    // The other one carries on, which is the whole point of switching them separately.
    expect(await service.getConnectivity(47.37, 8.54, ['ch'])).not.toBeNull();
  });

  it('treats a source nobody has an opinion about as on', async () => {
    // An operator who has never opened the settings page, and a source added by a later release,
    // are the same case: absent must not mean off.
    state.settings = { connectivityEnabled: true, connectivitySources: { 'ch-bakom': true } };
    const service = await loadService();

    expect(await service.getConnectivity(52.52, 13.405, ['de'])).not.toBeNull();
  });

  it("asks the first of a country's registers that the operator has left switched on", async () => {
    // Italy has two, and they are alternatives rather than a pair: one reads a reseller's
    // catalogue, the other the wholesale networks, and no sensible verdict comes of merging them.
    // Which one answers is the switch the operator left on, which is the same switch that turns a
    // register off entirely - there is no second kind of setting for this.
    const service = await loadService();

    expect((await service.getConnectivity(45.79, 9.91, ['it'], 'Via Al Poggio 1/X, Ranzanico')).sourceId).toBe(
      'it-navigabene',
    );
    expect(state.fibermapCalls).toEqual([]);
  });

  it('swaps to the other register for the country when the first is switched off', async () => {
    state.settings = { connectivityEnabled: true, connectivitySources: { 'it-navigabene': false } };
    const service = await loadService();

    const result = await service.getConnectivity(45.79, 9.91, ['it'], 'Via Al Poggio 1/X, Ranzanico');

    expect(result.sourceId).toBe('it-fibermap');
    expect(state.italianCalls).toEqual([]);
    expect(state.fibermapCalls).toEqual(['Via Al Poggio 1/X, Ranzanico']);
  });

  it('asks nobody when every register for a country is switched off', async () => {
    state.settings = {
      connectivityEnabled: true,
      connectivitySources: { 'it-navigabene': false, 'it-fibermap': false },
    };
    const service = await loadService();

    expect(await service.getConnectivity(45.79, 9.91, ['it'], 'Via Al Poggio 1/X, Ranzanico')).toBeNull();
    expect(state.italianCalls).toEqual([]);
    expect(state.fibermapCalls).toEqual([]);
  });

  it('has no answer for a country no register covers', async () => {
    const service = await loadService();

    expect(await service.getConnectivity(38.72, -9.14, ['pt'])).toBeNull();
    expect(state.germanCalls).toEqual([]);
    expect(state.swissCalls).toEqual([]);
  });

  it('answers a second flat in the same building from the first lookup', async () => {
    const service = await loadService();

    await service.getConnectivity(52.52, 13.405, ['de']);
    await service.getConnectivity(52.52, 13.405, ['de']);

    expect(state.germanCalls).toHaveLength(1);
  });

  it('asks again for a place far enough away to be a different cell', async () => {
    const service = await loadService();

    await service.getConnectivity(52.52, 13.405, ['de']);
    await service.getConnectivity(52.53, 13.415, ['de']);

    expect(state.germanCalls).toHaveLength(2);
  });

  it('does not let one address answer for its neighbour where the register reads addresses', async () => {
    // The Italian checker is asked by door number and never sees the coordinate, so two listings
    // in the same ten-metre cell are two questions - and one of them would otherwise be served the
    // other's verdict, or the empty answer an unreadable address produced.
    const service = await loadService();

    await service.getConnectivity(45.79, 9.91, ['it'], 'Via Al Poggio 1/X, Ranzanico');
    await service.getConnectivity(45.79, 9.91, ['it'], 'Via Roma 4, Ranzanico');

    expect(state.italianCalls).toEqual(['Via Al Poggio 1/X, Ranzanico', 'Via Roma 4, Ranzanico']);
  });

  it('answers a second listing at the same address from the first lookup', async () => {
    const service = await loadService();

    await service.getConnectivity(45.79, 9.91, ['it'], 'Via Al Poggio 1/X, Ranzanico');
    // The same address as the portal next door prints it: spacing and case are not a new question.
    await service.getConnectivity(45.79, 9.91, ['it'], '  via al  poggio 1/X,   Ranzanico ');

    expect(state.italianCalls).toHaveLength(1);
  });

  it('still collapses two spellings of one place for a register asked by point', async () => {
    // The mirror image: the German register never reads the address, so letting it into the key
    // would turn one cell's answer into as many lookups as the portals have ways of writing it.
    const service = await loadService();

    await service.getConnectivity(52.52, 13.405, ['de'], 'Hauptstr. 1, Berlin');
    await service.getConnectivity(52.52, 13.405, ['de'], 'Hauptstraße 1, Berlin');

    expect(state.germanCalls).toHaveLength(1);
  });

  it('does not let one register answer for the other at the same coordinate', async () => {
    // Near a border both registers are in range, and their answers are not interchangeable.
    const service = await loadService();

    await service.getConnectivity(47.6, 8.6, ['de']);
    await service.getConnectivity(47.6, 8.6, ['ch']);

    expect(state.germanCalls).toHaveLength(1);
    expect(state.swissCalls).toHaveLength(1);
  });

  it('comes back empty when the register failed rather than throwing', async () => {
    state.germanAnswer = null;
    const service = await loadService();

    expect(await service.getConnectivity(52.52, 13.405, ['de'])).toBeNull();
  });

  it('refuses a coordinate that is not one', async () => {
    const service = await loadService();

    expect(await service.getConnectivity(null, 13.405, ['de'])).toBeNull();
    expect(await service.getConnectivity(Number.NaN, Number.NaN, ['de'])).toBeNull();
    expect(state.germanCalls).toEqual([]);
  });

  it('reports which register is standing off', async () => {
    state.germanPaused = true;
    const service = await loadService();

    expect(service.isSourcePaused('de-bba')).toBe(true);
    expect(service.isSourcePaused('ch-bakom')).toBe(false);
    expect(service.isSourcePaused('nonesuch')).toBe(false);
  });

  it('drops a switch for a source it has never heard of', async () => {
    const service = await loadService();

    // An outdated browser posting the settings page must not be able to write keys into the
    // stored map that nothing will ever read again.
    expect(service.normalizeSourceSwitches({ 'de-bba': false, 'xx-made-up': true })).toEqual({
      'de-bba': false,
      'ch-bakom': true,
      'it-navigabene': true,
      'it-fibermap': true,
      'at-rtr': true,
      'es-setid': true,
    });
  });

  it('spells out the columns the overview filters on', async () => {
    const service = await loadService();

    expect(service.toColumns(null)).toEqual({ maxDown: null, fiber: null, mobile: null });
    expect(service.toColumns({ maxDownMbit: 1000, fiber: true, mobile: { neutral: { '5g': true } } })).toMatchObject({
      maxDown: 1000,
      fiber: 1,
    });
  });
});
