/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';

import { resolveProxyUrl } from '../../lib/services/proxyUrl.js';

const ENV_PROXY = 'http://user:pass@proxy.example:12321';

describe('resolveProxyUrl', () => {
  it('prefers the admin setting', () => {
    expect(resolveProxyUrl({ proxyUrl: ' socks5://a:b@ui.example:1080 ' }, { FREDY_PROXY_URL: ENV_PROXY })).toBe(
      'socks5://a:b@ui.example:1080',
    );
  });

  it('falls back to FREDY_PROXY_URL when the setting is empty', () => {
    expect(resolveProxyUrl({ proxyUrl: '  ' }, { FREDY_PROXY_URL: ` ${ENV_PROXY} ` })).toBe(ENV_PROXY);
    expect(resolveProxyUrl({}, { FREDY_PROXY_URL: ENV_PROXY })).toBe(ENV_PROXY);
    expect(resolveProxyUrl(null, { FREDY_PROXY_URL: ENV_PROXY })).toBe(ENV_PROXY);
  });

  it('returns an empty string when neither is set', () => {
    expect(resolveProxyUrl({ proxyUrl: null }, {})).toBe('');
  });
});
