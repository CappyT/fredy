/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  queryListings: vi.fn(() => ({ totalNumber: 0, page: 1, result: [] })),
  getListingById: vi.fn(),
  getListingImage: vi.fn(() => null),
}));
vi.mock('../../lib/mcp/mcpAuthentication.js', () => ({
  authenticateToolCall: vi.fn(() => ({ user: { id: 'u1', isAdmin: false } })),
  checkJobAccess: vi.fn(() => true),
}));

import { getListingById, getListingImage } from '../../lib/services/storage/listingsStorage.js';
import { createMcpServer } from '../../lib/mcp/mcpAdapter.js';

/** A minimal but real JPEG header, long enough for the sniffing to reach a verdict. */
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0x11)]);
/** The same for PNG, so a stored blob and a downloaded one can be told apart in an assertion. */
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 0x22)]);

async function callTool(name, args) {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result;
}

/**
 * The photograph the MCP tool hands to a vision model.
 *
 * The url on a listing row is a rental: idealista signs its cloudfront links for about a day, so
 * fetching one answered 403 on exactly the adverts this instance had already downloaded and kept.
 * The tool now reads the stored bytes the way the image route does, and only falls back to the
 * portal for a row whose photograph was never kept.
 */
describe('MCP get_photo_for_listing', () => {
  /** @type {any} */
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    getListingById.mockReturnValue({ id: 'l1', title: 'Flat', image_url: 'https://cdn.example/expired.jpg' });
    getListingImage.mockReturnValue(null);
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('the tool must not reach the network in this case');
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('serves the bytes Fredy kept, without asking the portal', async () => {
    getListingImage.mockReturnValue({ mime_type: 'image/jpeg', bytes: jpegBytes });

    const result = await callTool('get_photo_for_listing', { listingId: 'l1' });

    expect(getListingImage).toHaveBeenCalledWith('l1');
    expect(result.content).toEqual([{ type: 'image', data: jpegBytes.toString('base64'), mimeType: 'image/jpeg' }]);
  });

  it('reads the format off the bytes when the stored content type is not one a model takes', async () => {
    getListingImage.mockReturnValue({ mime_type: 'application/octet-stream', bytes: pngBytes });

    const result = await callTool('get_photo_for_listing', { listingId: 'l1' });

    expect(result.content[0].mimeType).toBe('image/png');
  });

  it('falls back to the portal for a listing whose photograph was never kept', async () => {
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(url);
      return {
        ok: true,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => pngBytes,
      };
    };

    const result = await callTool('get_photo_for_listing', { listingId: 'l1' });

    expect(asked).toEqual(['https://cdn.example/expired.jpg']);
    expect(result.content[0].mimeType).toBe('image/png');
  });

  it('says so when neither the store nor the row has a photograph', async () => {
    getListingById.mockReturnValue({ id: 'l1', title: 'Flat', image_url: null });

    const result = await callTool('get_photo_for_listing', { listingId: 'l1' });

    expect(result.content[0].text).toContain('No image available');
  });

  it('refuses a listing the user may not see', async () => {
    getListingById.mockReturnValue(undefined);

    const result = await callTool('get_photo_for_listing', { listingId: 'l1' });

    expect(result.content[0].text).toContain('Listing not found or access denied.');
    expect(getListingImage).not.toHaveBeenCalled();
  });
});
