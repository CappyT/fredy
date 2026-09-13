/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { config as inberlinwohnen } from '../../lib/provider/inberlinwohnen.js';
import { config as subito } from '../../lib/provider/subito.js';

const berlinListing = (createdAt) => ({
  id: JSON.stringify({
    data: {
      item: [
        {
          id: 19537,
          createdAt,
          occupationDate: '01.09.2026',
          deeplink: 'https://www.howoge.de/wohnungen-gewerbe/wohnungssuche/detail/1771-14563-258.html',
        },
        { s: 'arr' },
      ],
    },
  }),
});

describe('InBerlinWohnen publication dates', () => {
  it('uses portal creation rather than the occupation date', () => {
    const listing = inberlinwohnen.normalize(berlinListing('2026-07-26T16:38:04.000000Z'));
    expect(listing.publishedAt).toBe(Date.UTC(2026, 6, 26, 16, 38, 4));
    expect(listing.description).toContain('01.09.2026');
  });

  it.each([undefined, null, '', '2026-07-26T16:38:04', '2026-02-30T16:38:04Z'])(
    'does not infer publication from invalid or missing creation %j',
    (createdAt) => {
      expect(inberlinwohnen.normalize(berlinListing(createdAt)).publishedAt).toBeUndefined();
    },
  );
});

describe('Subito publication dates', () => {
  const advert = (date) => ({
    urn: 'id:ad:660342559:list:660342559',
    subject: 'TRILOCALE con CANTINA- in zona EUR',
    date,
  });

  it('converts the live Italian summer timestamp to epoch milliseconds', () => {
    expect(subito.normalize(advert('2026-09-11 14:41:46')).publishedAt).toBe(Date.UTC(2026, 8, 11, 12, 41, 46));
  });

  it('uses the winter offset instead of a fixed summer offset', () => {
    expect(subito.normalize(advert('2026-01-11 14:41:46')).publishedAt).toBe(Date.UTC(2026, 0, 11, 13, 41, 46));
  });

  it.each([undefined, null, '', 'not a date', '2026-02-30 14:41:46'])(
    'leaves invalid or missing dates unset: %j',
    (date) => {
      expect(subito.normalize(advert(date)).publishedAt).toBeUndefined();
    },
  );
});
