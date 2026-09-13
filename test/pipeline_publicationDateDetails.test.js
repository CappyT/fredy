/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';

afterEach(() => mockStore.setUserSettings(null));

describe('publication dates and detail opt-in', () => {
  it.each([undefined, [], ['another-provider']])(
    'does not fetch dates when details are disabled: %j',
    async (enabled) => {
      mockStore.setUserSettings({ provider_details: enabled });
      const Fredy = await mockFredy();
      const fetchDetails = vi.fn();
      const pipeline = new Fredy({ fetchDetails }, { id: 'date-job' }, 'date-provider', {});
      const listings = [{ id: 'no-date' }, { id: 'search-date', publishedAt: 1787653680000 }];
      expect(await pipeline._fetchDetails(listings)).toEqual(listings);
      expect(fetchDetails).not.toHaveBeenCalled();
    },
  );

  it('recovers dates through the existing detail request when enabled', async () => {
    mockStore.setUserSettings({ provider_details: ['date-provider'] });
    const Fredy = await mockFredy();
    const fetchDetails = vi.fn(async (listing) => ({ ...listing, publishedAt: 1787653680000 }));
    const pipeline = new Fredy({ fetchDetails }, { id: 'date-job' }, 'date-provider', {});
    expect(await pipeline._fetchDetails([{ id: 'no-date' }])).toEqual([{ id: 'no-date', publishedAt: 1787653680000 }]);
    expect(fetchDetails).toHaveBeenCalledTimes(1);
  });
});
