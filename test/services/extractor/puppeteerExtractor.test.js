/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock the CloakBrowser launcher so no real Chromium binary is needed and we can
// assert which options get forwarded to it.
const { launchMock, solveCaptchaMock, startDisplayMock, closeDisplayMock, restoreCookiesMock, persistCookiesMock } =
  vi.hoisted(() => ({
    launchMock: vi.fn(),
    restoreCookiesMock: vi.fn(),
    persistCookiesMock: vi.fn(),
    startDisplayMock: vi.fn(),
    closeDisplayMock: vi.fn(async () => {}),
    solveCaptchaMock: vi.fn(),
  }));

vi.mock('../../../lib/services/datadome/browserCookies.js', () => ({
  restoreDataDomeCookies: restoreCookiesMock,
  persistDataDomeCookies: persistCookiesMock,
}));

vi.mock('../../../lib/services/extractor/virtualDisplay.js', () => ({ startVirtualDisplay: startDisplayMock }));

beforeEach(() => {
  startDisplayMock.mockReset().mockResolvedValue({ display: ':123', close: closeDisplayMock });
  closeDisplayMock.mockClear();
  restoreCookiesMock.mockReset().mockResolvedValue();
  persistCookiesMock.mockReset().mockResolvedValue();
});

vi.mock('cloakbrowser/puppeteer', () => ({
  launch: launchMock,
}));

vi.mock('../../../lib/services/datadome/captcha.js', () => ({
  solveCaptcha: solveCaptchaMock,
}));

const {
  launchBrowser,
  closeBrowser,
  default: execute,
} = await import('../../../lib/services/extractor/puppeteerExtractor.js');

/**
 * Builds a browser test double around a fake Chromium child process.
 *
 * @param {object} [options]
 * @param {boolean} [options.closeFails] let `close()` reject, as it does once the CDP connection died
 * @param {boolean} [options.alive] whether the child process is still running when `close()` returned
 * @returns {{browser: object, childProcess: object, close: import('vitest').Mock}}
 */
function createBrowser({ closeFails = false, alive = true } = {}) {
  const childProcess = {
    pid: 4711,
    exitCode: alive ? null : 0,
    signalCode: null,
    kill: vi.fn(() => true),
  };
  const close = vi.fn(async () => {
    if (closeFails) throw new Error('Connection closed');
  });
  return { browser: { close, process: () => childProcess }, childProcess, close };
}

describe('launchBrowser proxy forwarding', () => {
  beforeEach(() => {
    launchMock.mockReset();
    launchMock.mockResolvedValue({ close: async () => {} });
  });

  it('forwards proxyUrl to CloakBrowser as the proxy option', async () => {
    await launchBrowser('https://www.immowelt.de/', { proxyUrl: 'http://user:pass@host:8080' });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0][0]).toMatchObject({ proxy: 'http://user:pass@host:8080' });
    expect(restoreCookiesMock).toHaveBeenCalledWith(
      await launchMock.mock.results[0].value,
      'http://user:pass@host:8080',
    );
  });

  it('does not set a proxy when no proxyUrl is given', async () => {
    await launchBrowser('https://www.immowelt.de/', {});

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0][0].proxy).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'linux')('captcha virtual display', () => {
  beforeEach(() => {
    vi.stubEnv('DISPLAY', undefined);
    launchMock.mockReset().mockResolvedValue({ close: vi.fn(async () => {}) });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('starts a private display only for the captcha browser and leaves process DISPLAY unchanged', async () => {
    const browser = await launchBrowser('https://example.com/', { datadome: true });
    expect(startDisplayMock).toHaveBeenCalledOnce();
    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: false,
        launchOptions: { env: expect.objectContaining({ DISPLAY: ':123' }) },
      }),
    );
    expect(process.env.DISPLAY).toBeUndefined();
    await closeBrowser(browser);
    expect(closeDisplayMock).toHaveBeenCalledOnce();
  });

  it.each([{}, { datadome: true, puppeteerHeadless: true }])('preserves headless for %j', async (options) => {
    await launchBrowser('https://example.com/', options);
    expect(startDisplayMock).not.toHaveBeenCalled();
    expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
  });

  it('isolates captcha windows from the existing Wayland and XWayland session', async () => {
    const desktopEnv = {
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      WAYLAND_SOCKET: '7',
      XAUTHORITY: '/desktop/auth',
      XDG_SESSION_TYPE: 'wayland',
    };
    for (const [key, value] of Object.entries(desktopEnv)) vi.stubEnv(key, value);
    const browser = await launchBrowser('https://example.com/', { datadome: true });
    expect(startDisplayMock).toHaveBeenCalledOnce();
    const options = launchMock.mock.calls[0][0];
    expect(options.headless).toBe(false);
    expect(options.args).toContain('--ozone-platform=x11');
    expect(options.launchOptions.env.DISPLAY).toBe(':123');
    expect(options.launchOptions.env.XDG_SESSION_TYPE).toBe('x11');
    for (const key of ['WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XAUTHORITY']) {
      expect(options.launchOptions.env).not.toHaveProperty(key);
    }
    for (const [key, value] of Object.entries(desktopEnv)) expect(process.env[key]).toBe(value);
    await closeBrowser(browser);
    expect(closeDisplayMock).toHaveBeenCalledOnce();
  });

  it('preserves an explicitly windowed non-captcha browser on the desktop display', async () => {
    vi.stubEnv('DISPLAY', ':0');
    await launchBrowser('https://example.com/', { puppeteerHeadless: false });
    expect(startDisplayMock).not.toHaveBeenCalled();
    expect(launchMock.mock.calls[0][0].launchOptions).toBeUndefined();
    expect(launchMock.mock.calls[0][0].args).not.toContain('--ozone-platform=x11');
  });

  it('closes the display if browser launch fails', async () => {
    const error = new Error('browser failed');
    launchMock.mockRejectedValue(error);
    await expect(launchBrowser('https://example.com/', { datadome: true })).rejects.toBe(error);
    expect(closeDisplayMock).toHaveBeenCalledOnce();
  });

  it('closes the display on disconnection and when browser.close rejects', async () => {
    const callbacks = {};
    launchMock.mockResolvedValue({
      once: (event, callback) => {
        callbacks[event] = callback;
      },
      close: async () => {
        throw new Error('disconnected');
      },
    });
    const browser = await launchBrowser('https://example.com/', { datadome: true });
    callbacks.disconnected();
    expect(closeDisplayMock).toHaveBeenCalledOnce();
    await expect(closeBrowser(browser)).resolves.toBeUndefined();
  });
});

describe('closeBrowser', () => {
  /** @type {import('vitest').MockInstance} */
  let killSpy;

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('does nothing when there is no browser', async () => {
    await expect(closeBrowser(null)).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('closes the browser and does not signal a process that already exited', async () => {
    const { browser, childProcess, close } = createBrowser({ alive: false });

    await closeBrowser(browser);

    expect(close).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.kill).not.toHaveBeenCalled();
  });

  it('persists cookies before the browser destroys its context', async () => {
    const { browser, close } = createBrowser({ alive: false });
    await closeBrowser(browser);
    expect(persistCookiesMock).toHaveBeenCalledWith(browser);
    expect(persistCookiesMock.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it('kills the process group when close() rejected and Chromium is still running', async () => {
    const { browser, childProcess } = createBrowser({ closeFails: true });

    await closeBrowser(browser);

    // negative pid = the detached process group, so the helper processes go down with the browser
    expect(killSpy).toHaveBeenCalledWith(-4711, 'SIGKILL');
    expect(childProcess.kill).not.toHaveBeenCalled();
  });

  it('falls back to killing the single process when there is no process group', async () => {
    const { browser, childProcess } = createBrowser({ closeFails: true });
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });

    await closeBrowser(browser);

    expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('swallows a kill that fails because the process is already gone', async () => {
    const { browser, childProcess } = createBrowser({ closeFails: true });
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    childProcess.kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });

    await expect(closeBrowser(browser)).resolves.toBeUndefined();
  });
});

describe('execute, the DataDome flag', () => {
  const URL = 'https://www.casa.it/affitto/residenziale/roma/';
  const SOURCE = '<html><body>the rendered page</body></html>';

  /**
   * A browser whose one page renders whatever it is asked to navigate to.
   *
   * @param {object} [options]
   * @param {number} [options.status] the status the navigation answers with
   * @returns {{browser: object, page: object}}
   */
  function renderingBrowser({ status = 200 } = {}) {
    const page = {
      goto: vi.fn(async () => ({ status: () => status })),
      waitForSelector: vi.fn(async () => null),
      evaluate: vi.fn(async () => SOURCE),
      content: vi.fn(async () => SOURCE),
      close: vi.fn(async () => {}),
    };
    return { browser: { newPage: async () => page, close: async () => {} }, page };
  }

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    solveCaptchaMock.mockResolvedValue(false);
  });

  it.each([
    [true, undefined, false],
    [true, true, true],
    [undefined, undefined, true],
  ])('uses humanize=%s/%s as %s when launching its own browser', async (datadome, humanize, expected) => {
    const { browser } = renderingBrowser();
    launchMock.mockReset();
    launchMock.mockResolvedValue(browser);

    expect(await execute(URL, 'body', { datadome, humanize })).toBe(SOURCE);
    expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({ humanize: expected }));
  });

  it('allows the page hook to recover a blocked response', async () => {
    const { browser, page } = renderingBrowser({ status: 403 });
    const onPage = vi.fn(async () => true);

    expect(await execute(URL, 'body', { browser, onPage })).toBe(SOURCE);
    expect(onPage).toHaveBeenCalledWith(page);
    expect(page.close).toHaveBeenCalledOnce();
  });

  it('retains solver recovery when the page hook throws', async () => {
    const { browser, page } = renderingBrowser({ status: 403 });
    solveCaptchaMock.mockResolvedValue(true);
    const onPage = async () => {
      throw new Error('hook failed');
    };

    expect(await execute(URL, 'body', { browser, datadome: true, onPage })).toBe(SOURCE);
    expect(page.close).toHaveBeenCalledOnce();
  });

  it('keeps an unresolved blocked response blocked', async () => {
    const { browser, page } = renderingBrowser({ status: 403 });

    expect(await execute(URL, 'body', { browser, datadome: true })).toBeNull();
    expect(page.close).toHaveBeenCalledOnce();
  });

  it('hands the solver the page and what the navigation answered', async () => {
    const { browser, page } = renderingBrowser();

    const html = await execute(URL, 'body', { browser, datadome: true });

    expect(solveCaptchaMock).toHaveBeenCalledTimes(1);
    expect(solveCaptchaMock.mock.calls[0][0]).toBe(page);
    expect(solveCaptchaMock.mock.calls[0][1].response.status()).toBe(200);
    expect(html).toBe(SOURCE);
  });

  it('passes the solver its options when the flag carries them', async () => {
    const { browser } = renderingBrowser();

    await execute(URL, 'body', { browser, datadome: { attempts: 5 } });

    expect(solveCaptchaMock).toHaveBeenCalledWith(expect.anything(), { attempts: 5, response: expect.anything() });
  });

  it('stays out of the way when the flag is not set', async () => {
    const { browser } = renderingBrowser({ status: 403 });

    const html = await execute(URL, 'body', { browser });

    expect(solveCaptchaMock).not.toHaveBeenCalled();
    // Without the flag a 403 is a bot wall, whatever the document turned into.
    expect(html).toBeNull();
  });

  it('treats a cleared wall as a navigation that recovered', async () => {
    const { browser } = renderingBrowser({ status: 403 });
    solveCaptchaMock.mockResolvedValue(true);

    const html = await execute(URL, 'body', { browser, datadome: true });

    // The page behind a cleared wall is the document to read, not a refusal.
    expect(html).toBe(SOURCE);
  });

  it('still answers with the page when the solver throws', async () => {
    const { browser } = renderingBrowser();
    solveCaptchaMock.mockRejectedValue(new Error('frame went missing'));

    const html = await execute(URL, 'body', { browser, datadome: true });

    expect(html).toBe(SOURCE);
  });
});
