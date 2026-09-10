/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

// The real configurations, imported before any `vi.doMock` below can shadow them. What each
// provider declares is the thing the sweep is built on, so it is asserted against the modules
// themselves rather than against the stubs.
import { config as idealistaConfig } from '../../../lib/provider/idealista.js';
import { config as immobiliareConfig } from '../../../lib/provider/immobiliare.js';
import { config as tecnocasaConfig } from '../../../lib/provider/tecnocasa.js';
import { config as tecnoreteConfig } from '../../../lib/provider/tecnorete.js';

const root = (await import('node:path')).resolve('.');
const listingsStoragePath = root + '/lib/services/storage/listingsStorage.js';
const settingsStoragePath = root + '/lib/services/storage/settingsStorage.js';
const loggerPath = root + '/lib/services/logger.js';

/**
 * The four providers whose config the sweep borrows, stubbed per test. Each provider module is
 * mocked wholesale - the sweep only ever touches `config.fetchDetails`, the fields it declares and
 * the two pacing numbers beside them, and the real ones would reach for the network.
 */
const providerIds = ['tecnocasa', 'tecnorete', 'idealista', 'immobiliare'];

let state;

async function loadCron() {
  vi.resetModules();
  vi.doMock(listingsStoragePath, () => ({
    getListingsMissingDetails: (providerFields, options) => {
      state.askedFields = providerFields;
      state.askedOptions = options;
      return state.pending.filter((listing) => providerFields[listing.provider] != null);
    },
    markDetailBackfillAttempt: (id) => {
      if (state.unwritableRows?.includes(id)) throw new Error('database is locked');
      state.attempts.push(id);
    },
    updateListingDescription: (id, description) => state.storedDescriptions.push({ id, description }),
    updateListingPublishedAt: (id, publishedAt) => state.storedDates.push({ id, publishedAt }),
  }));
  vi.doMock(settingsStoragePath, () => ({
    getUserSettings: (userId) => {
      state.settingsReads.push(userId);
      return state.settings[userId] ?? {};
    },
  }));
  for (const providerId of providerIds) {
    vi.doMock(`${root}/lib/provider/${providerId}.js`, () => ({
      config: {
        detailFetchDelayMs: 10,
        detailFetchJitterMs: 0,
        detailFields: state.declared?.[providerId] ?? ['description', 'publishedAt'],
        fetchDetails: async (listing) => {
          state.detailCalls.push({ provider: providerId, link: listing.link });
          if (state.failLinks?.includes(listing.link)) throw new Error('the host refused');
          return state.details[`${providerId}:${listing.link}`] ?? {};
        },
      },
    }));
  }
  vi.doMock(loggerPath, () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
  vi.doMock('node-cron', () => ({
    default: { schedule: (expression, task) => state.schedules.push({ expression, task }) },
  }));
  return import(root + '/lib/services/crons/listing-detail-cron.js');
}

/** Run one sweep to completion, letting the paced sleeps through. */
async function sweep(cron, options) {
  vi.useFakeTimers();
  const running = cron.runDetailBackfill(options);
  await vi.runAllTimersAsync();
  return running;
}

/**
 * The one sweep that repairs both columns a scrape can leave empty.
 *
 * It exists for two kinds of row: an upgrade's back catalogue, stored before the provider read
 * either value, and the batch a run stored while its detail reads were being refused - a search
 * expanded into a hundred new listings can earn a block partway through, and the pipeline enriches
 * only what it has not stored yet. What it may and may not do is shaped by four facts: both
 * columns come off one page and must cost one request, a provider with no place to ask must never
 * enter the work list, a portal's detail page is only read for a user who asked for detail pages
 * to be read, and every attempt is recorded so a row nobody can fill is not re-read forever.
 */
describe('services/crons/listing-detail-cron', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Nothing in the sweep may reach the network in a test; the provider configs are mocked.
    globalThis.fetch = async () => {
      throw new Error('network is off limits in this test');
    };
    state = {
      pending: [],
      storedDescriptions: [],
      storedDates: [],
      attempts: [],
      detailCalls: [],
      details: {},
      settings: { 'user-1': { provider_details: providerIds } },
      settingsReads: [],
      schedules: [],
      askedFields: null,
      askedOptions: null,
      declared: {},
      unwritableRows: [],
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  const row = (id, overrides = {}) => ({
    id,
    link: `https://www.tecnocasa.it/vendita/${id}.html`,
    provider: 'tecnocasa',
    user_id: 'user-1',
    needs_description: 1,
    needs_published_at: 1,
    ...overrides,
  });

  it('writes both columns from a single detail read', async () => {
    state.pending = [row('row-1')];
    state.details['tecnocasa:https://www.tecnocasa.it/vendita/row-1.html'] = {
      description: 'Trilocale luminoso.',
      publishedAt: Date.UTC(2026, 5, 1, 10, 0, 0),
    };

    const cron = await loadCron();
    await sweep(cron);

    // One request for two columns: the old pair of sweeps asked the same host twice per row.
    expect(state.detailCalls).toHaveLength(1);
    expect(state.storedDescriptions).toEqual([{ id: 'row-1', description: 'Trilocale luminoso.' }]);
    expect(state.storedDates).toEqual([{ id: 'row-1', publishedAt: Date.UTC(2026, 5, 1, 10, 0, 0) }]);
  });

  it('writes only the column the row is actually missing', async () => {
    state.pending = [row('row-1', { needs_description: 0 })];
    state.details['tecnocasa:https://www.tecnocasa.it/vendita/row-1.html'] = {
      description: 'A text the row already has.',
      publishedAt: Date.UTC(2026, 5, 1, 10, 0, 0),
    };

    const cron = await loadCron();
    await sweep(cron);

    expect(state.storedDescriptions).toEqual([]);
    expect(state.storedDates).toHaveLength(1);
  });

  it('names the whole enricher map, so a provider is never left with rows nobody reads', async () => {
    state.pending = [row('row-1')];

    const cron = await loadCron();
    await sweep(cron);

    expect(Object.keys(state.askedFields).sort()).toEqual(['idealista', 'immobiliare', 'tecnocasa', 'tecnorete']);
  });

  it('asks for each provider only the columns that provider says it can fill', async () => {
    state.declared = { idealista: ['publishedAt'] };
    state.pending = [row('row-1')];

    const cron = await loadCron();
    await sweep(cron);

    // idealista's detail read sets the date and nothing else, so a row of its that lacks only a
    // description has nowhere to get one - it used to be re-read every fortnight forever.
    expect(state.askedFields.idealista).toEqual(['publishedAt']);
    expect(state.askedFields.immobiliare).toEqual(['description', 'publishedAt']);
  });

  it('leaves out a provider that declares nothing rather than sweeping it blind', async () => {
    state.declared = { idealista: [] };
    state.pending = [row('row-1')];

    const cron = await loadCron();
    await sweep(cron);

    expect(state.askedFields.idealista).toBeUndefined();
    expect(Object.keys(state.askedFields).sort()).toEqual(['immobiliare', 'tecnocasa', 'tecnorete']);
  });

  it('marks every attempt, including the one that answered nothing', async () => {
    state.pending = [row('answered'), row('silent'), row('refused')];
    state.details['tecnocasa:https://www.tecnocasa.it/vendita/answered.html'] = { description: 'Testo.' };
    state.failLinks = ['https://www.tecnocasa.it/vendita/refused.html'];

    const cron = await loadCron();
    await sweep(cron);

    // Without this the rows nobody can fill were re-read every single night, forever.
    expect(state.attempts).toEqual(['answered', 'silent', 'refused']);
    expect(state.storedDescriptions).toEqual([{ id: 'answered', description: 'Testo.' }]);
  });

  it('carries on when one detail read is refused', async () => {
    state.pending = [row('row-1'), row('row-2')];
    state.failLinks = ['https://www.tecnocasa.it/vendita/row-1.html'];
    state.details['tecnocasa:https://www.tecnocasa.it/vendita/row-2.html'] = {
      publishedAt: Date.UTC(2026, 5, 3, 8, 0, 0),
    };

    const cron = await loadCron();
    await sweep(cron);

    expect(state.detailCalls).toHaveLength(2);
    expect(state.storedDates).toEqual([{ id: 'row-2', publishedAt: Date.UTC(2026, 5, 3, 8, 0, 0) }]);
  });

  it('reads no detail page for a user who did not ask for that portal to be read', async () => {
    state.settings = { 'user-1': { provider_details: ['idealista'] } };
    state.pending = [row('row-1')];

    const cron = await loadCron();
    await sweep(cron);

    // The same opt-in the pipeline honours: a request at a portal is the user's to authorise.
    expect(state.detailCalls).toEqual([]);
    // Marked all the same. The work list is capped per run now, and an un-marked row is handed back
    // on every tick - on an instance whose users have ticked nothing, the same few hundred rows
    // filled the batch forever and the opted-in ones were never reached. The cost is one retry
    // window before a newly ticked portal's back catalogue is walked.
    expect(state.attempts).toEqual(['row-1']);
  });

  it('carries on when the database will not take the marker for one row', async () => {
    state.pending = [row('busy'), row('fine')];
    state.unwritableRows = ['busy'];

    const cron = await loadCron();
    await sweep(cron);

    // The marker is bookkeeping, not the work. It used to sit outside the per-row try, so a single
    // SQLITE_BUSY threw out of the sweep and every row queued behind it went unread - and at
    // startup, where nothing caught the chain, it took the process with it.
    expect(state.detailCalls.map((call) => call.link)).toEqual([row('fine').link]);
    expect(state.attempts).toEqual(['fine']);
  });

  it('reads the opt-in once per user, not once per row', async () => {
    state.pending = [row('row-1'), row('row-2'), row('row-3', { user_id: 'user-2' })];
    state.settings['user-2'] = { provider_details: providerIds };

    const cron = await loadCron();
    await sweep(cron);

    expect(state.settingsReads).toEqual(['user-1', 'user-2']);
    expect(state.detailCalls).toHaveLength(3);
  });

  it('leaves a row belonging to no job alone rather than reading it for nobody', async () => {
    state.pending = [row('orphan', { user_id: null })];

    const cron = await loadCron();
    await sweep(cron);

    expect(state.detailCalls).toEqual([]);
  });

  it('does no work at all when nothing is missing', async () => {
    const cron = await loadCron();
    const didWork = await cron.runDetailBackfill();

    expect(didWork).toBe(true);
    expect(state.detailCalls).toEqual([]);
  });

  it('skips a trigger that arrives while a sweep is still in flight', async () => {
    state.pending = [row('row-1')];

    const cron = await loadCron();
    vi.useFakeTimers();
    const first = cron.runDetailBackfill();
    const second = await cron.runDetailBackfill();

    await vi.runAllTimersAsync();
    await first;

    expect(second).toBe(false);
    expect(state.detailCalls).toHaveLength(1);
  });

  it('paces itself with the delay the provider declares, from the very first request', async () => {
    state.pending = [row('row-1'), row('row-2')];

    const cron = await loadCron();
    vi.useFakeTimers();
    const running = cron.runDetailBackfill();

    // Nothing has been asked yet: the sweep arrives at the host with a back catalogue, so unlike
    // the pipeline it waits before the first request too.
    await vi.advanceTimersByTimeAsync(0);
    expect(state.detailCalls).toEqual([]);

    await vi.runAllTimersAsync();
    await running;
    expect(state.detailCalls).toHaveLength(2);
  });

  it('only schedules - the startup pass is sequenced against the image sweep by index.js', async () => {
    const cron = await loadCron();

    cron.initListingDetailCron();

    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0].expression).toBe('30 4 * * *');
    expect(state.detailCalls).toEqual([]);
  });
});

/**
 * What the swept providers promise, and what the process does with the sweep that reads them.
 *
 * Both belong beside the sweep rather than with their own modules: a declaration is only ever read
 * here, and the startup chain exists only to run this sweep and the image one after it.
 */
describe('services/crons/listing-detail-cron - the declarations and the startup chain', () => {
  it('declares, per provider, exactly the columns its detail read sets', () => {
    // immobiliare's app api answers one advert with its dates and its text; the tecnocasa group's
    // estate payload does the same. idealista's reads `modificationDate` and nothing else, which is
    // the whole reason the sweep asks per provider instead of per row.
    expect(immobiliareConfig.detailFields).toEqual(['description', 'publishedAt']);
    expect(tecnocasaConfig.detailFields).toEqual(['description', 'publishedAt']);
    expect(tecnoreteConfig.detailFields).toEqual(['description', 'publishedAt']);
    expect(idealistaConfig.detailFields).toEqual(['publishedAt']);
  });

  it('never lets the startup sweeps reject, because an unhandled one ends the process', async () => {
    const source = await readFile(new URL('../../../index.js', import.meta.url), 'utf-8');
    const chain = source.slice(source.indexOf('await runDetailBackfill()'));

    // Every row of both sweeps writes to SQLite, so one SQLITE_BUSY used to escape as an unhandled
    // rejection seconds after Fredy finished starting - and take it down with it.
    expect(chain).toMatch(/\}\)\(\)\s*\.catch\(/);
  });
});
