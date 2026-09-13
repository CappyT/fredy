/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { fetchListingImage } from '../../../lib/services/listings/imageFetcher.js';

describe('fetchListingImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    'http://192.168.1.1/photo.jpg',
    'http://localhost/photo.jpg',
    'http://169.254.169.254/latest',
    'file:///etc/passwd',
  ])('does not request %s', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchListingImage(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads a public image', async () => {
    const fetchMock = vi.fn(
      async () => new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/jpeg; charset=binary' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const image = await fetchListingImage('https://img.example.com/photo.jpg');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(image.mimeType).toBe('image/jpeg');
    expect(image.bytes.length).toBe(3);
  });
});
