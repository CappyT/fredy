/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { clearcoteOptedIn } from '../../../lib/services/extractor/forkBrowserEngine.js';

describe('clearcoteOptedIn', () => {
  it('keeps CloakBrowser when FREDY_BROWSER_ENGINE is not set', () => {
    expect(clearcoteOptedIn({})).toBe(false);
  });

  it.each(['clearcote', 'Clearcote', ' clearcote '])('drives Clearcote for %j', (value) => {
    expect(clearcoteOptedIn({ FREDY_BROWSER_ENGINE: value })).toBe(true);
  });

  it('keeps CloakBrowser for any other value', () => {
    expect(clearcoteOptedIn({ FREDY_BROWSER_ENGINE: 'cloakbrowser' })).toBe(false);
  });
});
