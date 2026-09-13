/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { load, save, warn, debug } = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('../../../lib/services/datadome/cookieStore.js', () => ({
  DataDomeCookieStore: class {
    load = load;
    save = save;
  },
}));
vi.mock('../../../lib/services/logger.js', () => ({ default: { warn, debug } }));
import { restoreDataDomeCookies, persistDataDomeCookies } from '../../../lib/services/datadome/browserCookies.js';

beforeEach(() => {
  vi.resetAllMocks();
  load.mockReturnValue([]);
});
const fakeBrowser = () => {
  const context = { setCookie: vi.fn(async () => {}), cookies: vi.fn(async () => []) };
  return { context, browser: { defaultBrowserContext: () => context } };
};

describe('browser DataDome cookie lifecycle', () => {
  it('restores before navigation and saves the latest cookies in the actual proxy scope', async () => {
    const { browser, context } = fakeBrowser();
    const initial = { name: 'datadome', value: 'old' };
    const updated = { name: 'datadome', value: 'new' };
    load.mockReturnValue([initial]);
    context.cookies.mockResolvedValue([updated]);
    await restoreDataDomeCookies(browser, 'proxy');
    expect(load).toHaveBeenCalledWith('proxy');
    expect(context.setCookie).toHaveBeenCalledWith(initial);
    await persistDataDomeCookies(browser);
    expect(save).toHaveBeenCalledWith('proxy', [updated], [initial]);
  });

  it('keeps concurrent browser proxy scopes separate', async () => {
    const a = fakeBrowser();
    const b = fakeBrowser();
    await Promise.all([restoreDataDomeCookies(a.browser, 'A'), restoreDataDomeCookies(b.browser, 'B')]);
    await persistDataDomeCookies(b.browser);
    await persistDataDomeCookies(a.browser);
    expect(save.mock.calls.map((args) => args[0])).toEqual(['B', 'A']);
  });

  it('continues after one rejected cookie without deleting its cached record', async () => {
    const { browser, context } = fakeBrowser();
    const rejected = { value: 'rejected' };
    const accepted = { value: 'accepted' };
    load.mockReturnValue([rejected, accepted]);
    context.setCookie.mockRejectedValueOnce(new Error('bad cookie'));
    await restoreDataDomeCookies(browser);
    await persistDataDomeCookies(browser);
    expect(context.setCookie).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith('', [], [accepted]);
  });

  it('does not let cache errors prevent startup or browser cleanup, or log secrets', async () => {
    const { browser } = fakeBrowser();
    load.mockImplementation(() => {
      throw new Error('secret-cookie-value');
    });
    save.mockImplementation(() => {
      throw new Error('secret-proxy-password');
    });
    await expect(restoreDataDomeCookies(browser)).resolves.toBeUndefined();
    await expect(persistDataDomeCookies(browser)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('ignores unregistered browsers and saves only once on repeated close', async () => {
    const { browser } = fakeBrowser();
    await persistDataDomeCookies(browser);
    expect(save).not.toHaveBeenCalled();
    await restoreDataDomeCookies(browser);
    await persistDataDomeCookies(browser);
    await persistDataDomeCookies(browser);
    expect(save).toHaveBeenCalledOnce();
  });
});
