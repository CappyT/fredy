/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  userCanAccessListing: vi.fn(() => true),
  getListingImage: vi.fn(),
  getListingById: vi.fn(),
}));
vi.mock('../../lib/services/logger.js', () => ({ default: { error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: vi.fn(() => false) }));

import * as listingStorage from '../../lib/services/storage/listingsStorage.js';
import { isAdmin } from '../../lib/api/security.js';
import listingsPlugin from '../../lib/api/routes/listingsRouter.js';

async function buildApp() {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: 'user-1' };
    request.currentUser = { id: 'user-1' };
  });
  await app.register(listingsPlugin);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  listingStorage.userCanAccessListing.mockReturnValue(true);
  isAdmin.mockReturnValue(false);
});

/**
 * The image route serves the bytes the scrape kept and falls back to the portal's own url where
 * none were kept yet. Its interesting cases are the access gate - a photograph is a listing's
 * data like its price is - and the fallbacks that keep a legacy row's gallery working.
 */
describe('GET /api/listings/:listingId/image', () => {
  it('serves the stored bytes with the content type they were kept under', async () => {
    listingStorage.getListingImage.mockReturnValue({ mime_type: 'image/webp', bytes: Buffer.from('photograph') });

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/row-1/image' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/webp');
    expect(response.headers['cache-control']).toContain('max-age');
    expect(response.body).toBe('photograph');
  });

  it('redirects to the portal url when the bytes are not kept yet', async () => {
    listingStorage.getListingImage.mockReturnValue(null);
    listingStorage.getListingById.mockReturnValue({ id: 'row-1', image_url: 'https://portal/img.jpg' });

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/row-1/image' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://portal/img.jpg');
  });

  it('answers 404 for a listing with neither bytes nor a portal url', async () => {
    listingStorage.getListingImage.mockReturnValue(null);
    listingStorage.getListingById.mockReturnValue({ id: 'row-1', image_url: null });

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/row-1/image' });

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for a listing the user cannot access, not 403, so ids cannot be probed', async () => {
    listingStorage.userCanAccessListing.mockReturnValue(false);

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/somebody-elses/image' });

    expect(response.statusCode).toBe(404);
    expect(listingStorage.getListingImage).not.toHaveBeenCalled();
  });
});
