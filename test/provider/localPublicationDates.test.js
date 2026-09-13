/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localPublicationDate, relativePublicationDate } from '../../lib/utils/publicationDate.js';
import { config as immoscout } from '../../lib/provider/immoscout.js';
import { config as einsA } from '../../lib/provider/einsAImmobilien.js';
import { config as kleinanzeigen } from '../../lib/provider/kleinanzeigen.js';
import { config as schwarzesbrett } from '../../lib/provider/schwarzesbrett.js';
import { config as immowelt } from '../../lib/provider/immowelt.js';
import { parse } from '../../lib/services/extractor/parser/parser.js';
import puppeteerExtractor from '../../lib/services/extractor/puppeteerExtractor.js';
import { fetchExposeHtml } from '../../lib/services/immowelt/immoweltBff.js';

vi.mock('../../lib/services/extractor/puppeteerExtractor.js', () => ({ default: vi.fn() }));
vi.mock('../../lib/services/immowelt/immoweltBff.js', () => ({ fetchExposeHtml: vi.fn(), searchClassifieds: vi.fn() }));
const fixture = (name) => readFileSync(new URL(`../testFixtures/${name}`, import.meta.url), 'utf8');
const reference = Date.parse('2026-09-11T12:30:00Z');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('portal-local publication dates', () => {
  it.each([
    ['2026-08-20', '2026-08-19T22:00:00Z'],
    ['20.01.2026', '2026-01-19T23:00:00Z'],
    ['2026-03-29', '2026-03-28T23:00:00Z'],
    ['2026-10-25', '2026-10-24T22:00:00Z'],
    ['2026-10-26', '2026-10-25T23:00:00Z'],
    ['2026-08-20 14:06:30', '2026-08-20T12:06:30Z'],
    ['2026-01-20 14:06', '2026-01-20T13:06:00Z'],
    ['2026-08-20T14:06:30.123Z', '2026-08-20T14:06:30.123Z'],
  ])('resolves %s in Europe/Berlin', (raw, expected) => {
    expect(localPublicationDate(raw, 'Europe/Berlin')).toBe(Date.parse(expected));
  });

  it.each([
    null,
    undefined,
    '',
    false,
    {},
    '2026-02-30',
    '31.04.2026',
    '2026-13-01',
    '2026-00-01',
    '2026-09-11 24:00',
    '2026-03-29 02:30',
    'vor 3 Tagen',
  ])('rejects invalid local date %j', (raw) => {
    expect(localPublicationDate(raw, 'Europe/Berlin')).toBeUndefined();
  });

  it('rejects invalid timezones and chooses the earlier instant during a DST overlap', () => {
    expect(localPublicationDate('2026-09-11', 'Invalid/Zone')).toBeUndefined();
    expect(localPublicationDate('2026-10-25 02:30', 'Europe/Berlin')).toBe(Date.parse('2026-10-25T00:30:00Z'));
  });

  it.each([
    ['vor 3 Tagen', '2026-09-07T22:00:00Z'],
    ['vor einem Tag', '2026-09-09T22:00:00Z'],
    ['vor einer Woche', '2026-09-03T22:00:00Z'],
    ['vor einem Monat', '2026-08-10T22:00:00Z'],
    ['vor 9 Monaten', '2025-12-10T23:00:00Z'],
    ['vor einem Jahr', '2025-09-10T22:00:00Z'],
    ['vor 4 Jahren', '2022-09-10T22:00:00Z'],
    ['Heute', '2026-09-10T22:00:00Z'],
    ['Gestern', '2026-09-09T22:00:00Z'],
    ['10 Tage, 16 Stunden', '2026-08-30T22:00:00Z'],
  ])('floors %s to the calculated local midnight', (raw, expected) => {
    expect(relativePublicationDate(raw, 'Europe/Berlin', reference)).toBe(Date.parse(expected));
  });

  it.each([
    ['vor 20 Sekunden', '2026-09-11T12:29:00Z'],
    ['vor 29 Minuten', '2026-09-11T12:01:00Z'],
    ['vor einer Stunde', '2026-09-11T11:30:00Z'],
    ['vor 15 Stunden', '2026-09-10T21:30:00Z'],
    ['11 Stunden, 39 Minuten', '2026-09-11T00:51:00Z'],
    ['Heute, 09:30', '2026-09-11T07:30:00Z'],
    ['Gestern, 17:30', '2026-09-10T15:30:00Z'],
  ])('keeps the minute of %s', (raw, expected) => {
    expect(relativePublicationDate(raw, 'Europe/Berlin', reference)).toBe(Date.parse(expected));
  });

  it.each([
    ['vor einem Monat', '2026-03-31T12:00:00Z', '2026-02-27T23:00:00Z'],
    ['vor einem Jahr', '2024-02-29T12:00:00Z', '2023-02-27T23:00:00Z'],
    ['vor einem Tag', '2026-03-29T22:30:00Z', '2026-03-28T23:00:00Z'],
    ['vor einem Tag', '2026-10-25T23:30:00Z', '2026-10-24T22:00:00Z'],
  ])('uses calendar arithmetic for %s at %s', (raw, now, expected) => {
    expect(relativePublicationDate(raw, 'Europe/Berlin', Date.parse(now))).toBe(Date.parse(expected));
  });

  it.each([
    ['vor 3 Stunden', '2026-03-29T02:30:00Z', '2026-03-28T23:30:00Z'],
    ['Heute, 02:30', '2026-03-29T10:00:00Z', '2026-03-28T23:00:00Z'],
    ['Heute, 01:30', '2026-10-25T10:00:00Z', '2026-10-24T23:30:00Z'],
    ['Heute, 03:30', '2026-10-25T10:00:00Z', '2026-10-25T02:30:00Z'],
  ])('resolves %s at %s across the Europe/Berlin DST change', (raw, now, expected) => {
    expect(relativePublicationDate(raw, 'Europe/Berlin', Date.parse(now))).toBe(Date.parse(expected));
  });

  it.each([
    null,
    undefined,
    '',
    'NEW',
    'vor kurzem',
    'vor -3 Tagen',
    '2026-09-11',
    'Heute, 25:00',
    '3 Tage garbage',
    '999999999999999999999 Tage',
    'vor 999999999999999999999 Tagen',
    'vor 9007199254740991 Stunden',
  ])('rejects unrecognized relative date %j', (raw) => {
    expect(relativePublicationDate(raw, 'Europe/Berlin', reference)).toBeUndefined();
  });

  it('rejects invalid reference times and timezones', () => {
    expect(relativePublicationDate('vor 3 Tagen', 'Europe/Berlin', NaN)).toBeUndefined();
    expect(relativePublicationDate('vor 3 Tagen', 'Invalid/Zone', reference)).toBeUndefined();
  });
});

describe('provider publication date propagation', () => {
  it('reads the relative dates from every ImmoScout fixture search result', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(reference);
    const body = JSON.parse(fixture('immoscout_list.json'));
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetch);
    const listings = (await immoscout.getListings('https://example.com/search')).map(immoscout.normalize);
    const raws = body.resultListItems
      .filter((entry) => entry.type === 'EXPOSE_RESULT')
      .map((entry) => entry.item.published);
    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    expect(listings).toHaveLength(50);
    listings.forEach((listing, index) => {
      expect(Number.isFinite(listing.publishedAt)).toBe(true);
      expect(localTime.format(listing.publishedAt) === '00:00:00').toBe(!/Minute|Stunde/.test(raws[index]));
    });
    expect(listings[raws.indexOf('vor 30 Minuten')].publishedAt).toBe(Date.parse('2026-09-11T12:00:00Z'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores project dates and access expiry when an ImmoScout listing has no date', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          resultListItems: [
            {
              type: 'EXPOSE_RESULT',
              item: { id: '1', paywallListing: { earlyAccessExpiresAt: '2026-09-13T12:00:00Z' } },
            },
            { type: 'EXPOSE_RESULT', item: { id: '2', published: 'unknown' } },
            { type: 'DEVELOPER_PROJECT_RESULT', item: { projectPublishDate: '2026-09-11T12:00:00Z' } },
          ],
        }),
      }),
    );
    const listings = (await immoscout.getListings('https://example.com/search')).map(immoscout.normalize);
    expect(listings).toHaveLength(2);
    expect(listings.every((listing) => listing.publishedAt === undefined)).toBe(true);
  });

  it('reads 1A update ages directly from search cards', () => {
    vi.spyOn(Date, 'now').mockReturnValue(reference);
    const listings = parse(
      einsA.crawlContainer,
      einsA.crawlFields,
      fixture('einsAImmobilien.html'),
      'https://example.com',
    ).map(einsA.normalize);
    expect(listings).toHaveLength(10);
    expect(listings.filter((listing) => listing.publishedAt != null)).toHaveLength(9);
    expect(listings[0].publishedAt).toBe(Date.parse('2026-08-30T22:00:00Z'));
  });

  it('reads Schwarzes Brett dates without detail requests', () => {
    const listings = parse(
      schwarzesbrett.crawlContainer,
      schwarzesbrett.crawlFields,
      fixture('schwarzesbrett.html'),
      'https://example.com',
    ).map(schwarzesbrett.normalize);
    expect(listings).toHaveLength(10);
    expect(listings.every((listing) => Number.isFinite(listing.publishedAt))).toBe(true);
    expect(listings[0].publishedAt).toBe(Date.parse('2026-08-24T22:00:00Z'));
  });

  it('matches Kleinanzeigen search dates by ID and preserves every card', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(reference);
    puppeteerExtractor.mockClear().mockResolvedValue(fixture('kleinanzeigen.html'));
    const listings = await kleinanzeigen.getListings('https://example.com/search');
    expect(listings).toHaveLength(27);
    expect(listings.every((listing) => Number.isFinite(kleinanzeigen.normalize(listing).publishedAt))).toBe(true);
    expect(listings.find((listing) => listing.id === '3471974249').publishedAt).toBe(
      Date.parse('2026-08-26T22:00:00Z'),
    );
    expect(listings.find((listing) => listing.id === '3465657924').publishedAt).toBe(
      Date.parse('2026-09-11T07:30:00Z'),
    );
    expect(listings.find((listing) => listing.id === '3406664283').publishedAt).toBe(
      Date.parse('2026-09-10T15:30:00Z'),
    );
    expect(puppeteerExtractor).toHaveBeenCalledTimes(1);
  });

  it('keeps Kleinanzeigen cards when embedded dates are absent or malformed', async () => {
    const html = fixture('kleinanzeigen.html').replace(/props="[^"]*"/g, 'props="invalid"');
    puppeteerExtractor.mockResolvedValue(html);
    const listings = await kleinanzeigen.getListings('https://example.com/search');
    expect(listings).toHaveLength(27);
    expect(listings.every((listing) => listing.publishedAt === undefined)).toBe(true);
  });

  it.each([
    ['Kleinanzeigen', kleinanzeigen, 'kleinanzeigen_detail.html', '2026-08-26T22:00:00Z'],
    ['Schwarzes Brett', schwarzesbrett, 'schwarzesbrett_detail.html', '2026-08-24T22:00:00Z'],
  ])('recovers the day from %s details', async (_, provider, name, expected) => {
    puppeteerExtractor.mockResolvedValue(fixture(name));
    expect((await provider.fetchDetails({ id: 'test', link: 'https://example.com/1' })).publishedAt).toBe(
      Date.parse(expected),
    );
    puppeteerExtractor.mockResolvedValue('<html></html>');
    expect(
      (await provider.fetchDetails({ id: 'test', link: 'https://example.com/1', publishedAt: reference })).publishedAt,
    ).toBe(reference);
    expect((await provider.fetchDetails({ id: 'test', link: 'https://example.com/1' })).publishedAt).toBeUndefined();
  });

  it('recovers Immowelt creation from detail server state and preserves an existing date on failure', async () => {
    const html = fixture('immowelt_detail_serverstate.html');
    const raw = html.match(/creationDate\\":\\"([^\\]+)\\"/)[1];
    fetchExposeHtml.mockResolvedValue(html);
    expect((await immowelt.fetchDetails({ id: 'test', link: 'https://example.com' })).publishedAt).toBe(
      Date.parse(raw),
    );
    fetchExposeHtml.mockResolvedValue('<html></html>');
    expect((await immowelt.fetchDetails({ id: 'test', publishedAt: reference })).publishedAt).toBe(reference);
    expect((await immowelt.fetchDetails({ id: 'test' })).publishedAt).toBeUndefined();
  });
});
