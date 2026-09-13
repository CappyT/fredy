/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pageProbe = vi.fn();
vi.mock('../../lib/services/listings/listingActiveTester.js', () => ({ default: pageProbe }));

const { probeAdvertActivity } = await import('../../lib/services/immobiliare/propertyDetail.js');

const LINK = 'https://www.immobiliare.it/annunci/131916338/';

describe('Immobiliare activity probe', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [200, 1],
    [404, 0],
    [410, 0],
    [403, -1],
    [429, -1],
    [503, -1],
  ])('maps a detail api %i to %i', async (status, expected) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeAdvertActivity(LINK)).resolves.toBe(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://android-imm-v4.ws-app.com/b2c/v2/properties/131916338');
    expect(pageProbe).not.toHaveBeenCalled();
  });

  it('gives no verdict when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    await expect(probeAdvertActivity(LINK)).resolves.toBe(-1);
  });

  it('falls back to the page probe for a link without an advert id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    pageProbe.mockResolvedValue(1);

    await expect(probeAdvertActivity('https://www.immobiliare.it/nuove-costruzioni/')).resolves.toBe(1);
    expect(pageProbe).toHaveBeenCalledWith('https://www.immobiliare.it/nuove-costruzioni/');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
