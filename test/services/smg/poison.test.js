/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import {
  detectPoison,
  readVerifiedPage,
  HONEST,
  POISONED,
  UNKNOWN,
  MAX_VERIFY_ATTEMPTS,
} from '../../../lib/services/smg/poison.js';

/**
 * The poison detector the two Swiss SMG providers share.
 *
 * The two value sets of the same listing are the recorded pair of id 4003474009: the honest copy
 * keeps 3 rooms, 70 m2 and a net rent of 990; the poisoned copy reports 1 room, 20 m2, no
 * `prices.rent.net` and a gross rent of 1220.
 */

/** The honest copy of the recorded listing. */
const HONEST_ROW = {
  id: '4003474009',
  offerType: 'rent',
  prices: { currency: 'CHF', rent: { net: 990, gross: 990 }, buy: null },
  characteristics: { numberOfRooms: 3, livingSpace: 70 },
};

/** The poisoned copy of the same listing. */
const POISONED_ROW = {
  id: '4003474009',
  offerType: 'rent',
  prices: { currency: 'CHF', rent: { gross: 1220 }, buy: null },
  characteristics: { numberOfRooms: 1, livingSpace: 20 },
};

/** @param {any[]} listings @param {Object} [query] @param {boolean} [expectNet] @returns {any} */
const detect = (listings, query = { offerType: 'RENT' }, expectNet = true) =>
  detectPoison({ listings, query, expectNet });

describe('the SMG poison detector', () => {
  it('calls a page honest when its rent rows keep the Nettomiete', () => {
    const verdict = detect([HONEST_ROW]);

    expect(verdict.verdict).toBe(HONEST);
    expect(verdict.reason).toContain('prices.rent.net');
  });

  it('calls a page poisoned when every rent row lost the Nettomiete', () => {
    const verdict = detect([POISONED_ROW, { ...POISONED_ROW, id: '2' }]);

    expect(verdict.verdict).toBe(POISONED);
    expect(verdict.reason).toContain('lost prices.rent.net');
  });

  it('reads the net-price signal on a page that mixes rent and purchase rows', () => {
    const buyRow = { id: '3', offerType: 'buy', prices: { rent: null, buy: { price: 890000 } } };

    expect(detect([buyRow, HONEST_ROW]).verdict).toBe(HONEST);
    expect(detect([buyRow, POISONED_ROW]).verdict).toBe(POISONED);
  });

  it('calls a page poisoned when a row breaks the request\u2019s own room filter', () => {
    const verdict = detect([POISONED_ROW], { offerType: 'RENT', numberOfRooms: { from: 3 } }, false);

    expect(verdict.verdict).toBe(POISONED);
    expect(verdict.reason).toContain('numberOfRooms=1');
  });

  it('calls a page honest when every row holds the numeric filters it asked for', () => {
    const verdict = detect(
      [HONEST_ROW],
      { offerType: 'RENT', numberOfRooms: { from: 3 }, livingSpace: { from: 60 } },
      false,
    );

    expect(verdict.verdict).toBe(HONEST);
    expect(verdict.reason).toContain('numberOfRooms');
  });

  it('calls a page poisoned when a row breaks the request\u2019s own price filter', () => {
    const verdict = detect([POISONED_ROW], { offerType: 'RENT', monthlyRent: { to: 1000 } }, false);

    expect(verdict.verdict).toBe(POISONED);
    expect(verdict.reason).toContain('price=1220');
  });

  it('accepts a rent row whose net price is inside the filter even when the gross is outside', () => {
    const row = { ...HONEST_ROW, prices: { rent: { net: 900, gross: 2400 } } };

    expect(detect([row], { offerType: 'RENT', monthlyRent: { to: 1000 } }, false).verdict).toBe(HONEST);
  });

  it('calls a page poisoned when the room sort steps backwards', () => {
    const row = (rooms) => ({ ...POISONED_ROW, characteristics: { numberOfRooms: rooms } });
    const verdict = detect(
      [row(1), row(1.8), row(3.5)],
      { offerType: 'RENT', sortBy: 'numberOfRooms', sortDirection: 'desc' },
      false,
    );

    expect(verdict.verdict).toBe(POISONED);
    expect(verdict.reason).toContain('numberOfRooms desc breaks');
  });

  it('tolerates half a room of slack in the room sort', () => {
    const row = (rooms) => ({ ...HONEST_ROW, characteristics: { numberOfRooms: rooms } });

    expect(
      detect([row(3.5), row(3.4), row(3)], { offerType: 'RENT', sortBy: 'numberOfRooms', sortDirection: 'desc' }, false)
        .verdict,
    ).toBe(HONEST);
  });

  it('does not flag a promoted first row as a broken room sort', () => {
    const row = (rooms) => ({ ...HONEST_ROW, characteristics: { numberOfRooms: rooms } });

    // A top listing can stand first regardless of the sort, so only the rows behind it are compared.
    expect(
      detect([row(1), row(3.5), row(3)], { offerType: 'RENT', sortBy: 'numberOfRooms', sortDirection: 'desc' }, false)
        .verdict,
    ).toBe(HONEST);
  });

  it('says unknown, never honest, when no signal can judge the page', () => {
    const rows = [{ id: '1', offerType: 'rent', prices: { rent: { gross: 1220 } }, characteristics: {} }];

    const verdict = detect(rows, { offerType: 'RENT' }, false);

    expect(verdict.verdict).toBe(UNKNOWN);
    expect(verdict.reason).toContain('no rent net price');
  });

  it('treats a commercial-only rent search as unknown rather than poisoned, because the signal is blind there', () => {
    const office = { id: '1', offerType: 'rent', prices: { rent: { gross: 1220 } }, characteristics: {} };

    expect(detect([office], { offerType: 'RENT' }, false).verdict).toBe(UNKNOWN);
  });

  it('calls an empty page honest, because it carries no rewritten row', () => {
    expect(detect([]).verdict).toBe(HONEST);
  });
});

describe('the bounded retry', () => {
  /** @param {any} listing @returns {any} */
  const page = (listing) => ({ results: [{ id: listing.id, listing }] });

  it('re-requests the same body until an honest page arrives', async () => {
    const answers = [page(POISONED_ROW), page(POISONED_ROW), page(HONEST_ROW)];
    const bodies = [];
    let index = 0;
    const requestPage = async (body) => {
      bodies.push(body);
      return answers[index++];
    };

    const result = await readVerifiedPage({
      requestPage,
      body: { from: 0 },
      query: { offerType: 'RENT' },
      expectNet: true,
    });

    expect(result.attempts).toBe(3);
    expect(result.verdict.verdict).toBe(HONEST);
    expect(result.answer.results[0].listing.characteristics.numberOfRooms).toBe(3);
    // Every attempt sent the same request: only the endpoint's random answer changes.
    expect(bodies).toEqual([{ from: 0 }, { from: 0 }, { from: 0 }]);
  });

  it('gives up at the cap and hands the last poisoned page back for the caller to drop', async () => {
    let calls = 0;
    const requestPage = async () => {
      calls++;
      return page(POISONED_ROW);
    };

    const result = await readVerifiedPage({ requestPage, body: {}, query: { offerType: 'RENT' }, expectNet: true });

    expect(calls).toBe(MAX_VERIFY_ATTEMPTS);
    expect(result.attempts).toBe(MAX_VERIFY_ATTEMPTS);
    expect(result.verdict.verdict).toBe(POISONED);
    // The poisoned rows are still there: it is the caller that must not store them.
    expect(result.answer).not.toBeNull();
  });

  it('stops without a verdict when the endpoint does not answer', async () => {
    const result = await readVerifiedPage({
      requestPage: async () => null,
      body: {},
      query: { offerType: 'RENT' },
      expectNet: true,
    });

    expect(result.answer).toBeNull();
    expect(result.verdict).toBeNull();
    expect(result.attempts).toBe(1);
  });
});
