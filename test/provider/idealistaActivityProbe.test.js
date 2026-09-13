/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../../lib/services/idealista/mobile-api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  call,
}));
const pageProbe = vi.fn();
vi.mock('../../lib/services/listings/listingActiveTester.js', () => ({ default: pageProbe }));

const { config } = await import('../../lib/provider/idealista.js');

const LINK = 'https://www.idealista.it/immobile/31395136/';

/**
 * @param {number} httpStatus
 * @returns {Error}
 */
function refusal(httpStatus) {
  return Object.assign(new Error(`idealista api answered ${httpStatus}`), { httpStatus });
}

describe('Idealista activity probe', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads an active advert off its detail', async () => {
    call.mockResolvedValue({ adid: 31395136, state: 'active' });

    await expect(config.activityProbe(LINK)).resolves.toBe(1);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'it' }),
      '/api/3/it/detail/31395136',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(pageProbe).not.toHaveBeenCalled();
  });

  it('treats a code the api does not know as gone', async () => {
    call.mockRejectedValue(refusal(404));

    await expect(config.activityProbe(LINK)).resolves.toBe(0);
  });

  it('gives no verdict for any other state', async () => {
    call.mockResolvedValue({ adid: 31395136, state: 'inactive' });

    await expect(config.activityProbe(LINK)).resolves.toBe(-1);
  });

  it.each([400, 407, 429, 503])('gives no verdict when the api answers %i', async (status) => {
    call.mockRejectedValue(refusal(status));

    await expect(config.activityProbe(LINK)).resolves.toBe(-1);
  });

  it('gives no verdict when the connection drops or the api is throttled', async () => {
    call.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { dropped: true }));
    await expect(config.activityProbe(LINK)).resolves.toBe(-1);

    call.mockRejectedValueOnce(new Error('idealista is silent to this installation until later.'));
    await expect(config.activityProbe(LINK)).resolves.toBe(-1);
  });

  it('falls back to the page probe for a link it cannot read', async () => {
    pageProbe.mockResolvedValue(1);

    await expect(config.activityProbe('https://www.idealista.it/vendita-case/milano-milano/')).resolves.toBe(1);
    expect(pageProbe).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });
});
