/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../lib/provider/casa.js';
import puppeteerExtractor from '../../lib/services/extractor/puppeteerExtractor.js';

vi.mock('../../lib/services/extractor/puppeteerExtractor.js', () => ({ default: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const link = 'https://www.casa.it/immobili/53711455/';
/** A search entry read off the website, which carries no date. */
const listing = () => config.normalize({ id: 53711455, uri: '/immobili/53711455/', title: { main: 'Trilocale' } });
const advert = (lastReviewed = '2026-08-26') => ({
  '@id': link,
  '@type': ['SingleFamilyResidence', 'Product', 'RealEstateListing', 'Apartment'],
  lastReviewed,
});
const detail = (nodes = [advert()], id = 53711455) =>
  `<script id="__NEXT_DATA__">${JSON.stringify({
    props: { pageProps: { pdp: { id, modified: '26 Agosto 2026', schema: { data: { '@graph': nodes } } } } },
  })}</script>`;

describe('Casa website publication date recovery', () => {
  it('recovers the observed update date at Italian midnight using the shared browser', async () => {
    puppeteerExtractor.mockResolvedValue(detail());
    const browser = {};
    const current = listing();
    expect(current.publishedAt).toBeUndefined();
    expect((await config.fetchDetails(current, browser)).publishedAt).toBe(Date.UTC(2026, 7, 25, 22));
    expect(puppeteerExtractor).toHaveBeenCalledTimes(1);
    expect(puppeteerExtractor).toHaveBeenCalledWith(link, 'body', { browser, name: 'casa_details' });
  });

  it('uses the winter timezone offset for day-only updates', async () => {
    puppeteerExtractor.mockResolvedValue(detail([advert('2026-01-26')]));
    expect((await config.fetchDetails(listing())).publishedAt).toBe(Date.UTC(2026, 0, 25, 23));
  });

  it('keeps an existing precise API timestamp without fetching a detail page', async () => {
    const current = config.normalize({ listing_id: 53711455, modified: '20260826T003616Z' });
    expect(current.publishedAt).toBe(Date.UTC(2026, 7, 25, 22, 36, 16));
    expect(await config.fetchDetails(current)).toBe(current);
    expect(puppeteerExtractor).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '2026-02-30', 'not a date'])('ignores invalid update dates %j', async (date) => {
    puppeteerExtractor.mockResolvedValue(detail([{ ...advert(), lastReviewed: date }]));
    expect((await config.fetchDetails(listing())).publishedAt).toBeUndefined();
  });

  it('rejects dates from other listings and from unrelated schema nodes', async () => {
    puppeteerExtractor.mockResolvedValue(
      detail([
        { ...advert(), '@id': 'https://www.casa.it/immobili/123/' },
        { ...advert(), '@type': 'WebSite' },
      ]),
    );
    expect((await config.fetchDetails(listing())).publishedAt).toBeUndefined();
    puppeteerExtractor.mockResolvedValue(detail([advert()], 123));
    expect((await config.fetchDetails(listing())).publishedAt).toBeUndefined();
  });

  it.each([null, '<html></html>', '<script id="__NEXT_DATA__">invalid</script>'])(
    'preserves the listing when the page has no usable payload: %j',
    async (html) => {
      puppeteerExtractor.mockResolvedValue(html);
      const current = listing();
      expect(await config.fetchDetails(current)).toBe(current);
    },
  );

  it('preserves the listing on fetch failure', async () => {
    puppeteerExtractor.mockRejectedValue(new Error('Unavailable'));
    const current = listing();
    expect(await config.fetchDetails(current)).toBe(current);
  });

  it('ignores a schema returned as an unexpected string', async () => {
    puppeteerExtractor.mockResolvedValue(
      `<script id="__NEXT_DATA__">${JSON.stringify({
        props: { pageProps: { pdp: { id: 53711455, schema: 'invalid' } } },
      })}</script>`,
    );
    expect((await config.fetchDetails(listing())).publishedAt).toBeUndefined();
  });

  it('reads a link on the bare casa.it host from the advert page on www', async () => {
    puppeteerExtractor.mockResolvedValue(detail());
    const current = { ...listing(), link: 'http://casa.it/immobili/53711455' };
    expect((await config.fetchDetails(current)).publishedAt).toBe(Date.UTC(2026, 7, 25, 22));
    expect(puppeteerExtractor).toHaveBeenCalledWith(link, 'body', { browser: undefined, name: 'casa_details' });
  });

  it.each([
    'https://example.com/immobili/53711455/',
    'https://www.casa.it.example.invalid/immobili/53711455/',
    'https://www.casa.it/affitto/residenziale/roma/',
    null,
  ])('does not fetch unsupported links: %j', async (unsupportedLink) => {
    const current = { id: 'test', link: unsupportedLink };
    expect(await config.fetchDetails(current)).toBe(current);
    expect(puppeteerExtractor).not.toHaveBeenCalled();
  });
});
