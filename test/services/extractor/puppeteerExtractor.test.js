/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock the CloakBrowser launcher so no real Chromium binary is needed and we can
// assert which options get forwarded to it.
const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));

vi.mock('cloakbrowser/puppeteer', () => ({
  launch: launchMock,
}));

const { launchBrowser, closeBrowser, newIsolatedPage } =
  await import('../../../lib/services/extractor/puppeteerExtractor.js');

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
  });

  it('does not set a proxy when no proxyUrl is given', async () => {
    await launchBrowser('https://www.immowelt.de/', {});

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0][0].proxy).toBeUndefined();
  });
});

/**
 * A browser that records what every isolated page was authenticated with, which is the only place
 * the exit node of a request is decided.
 *
 * @returns {{browser: object, authenticated: Array<{username: string, password: string}>}}
 */
function recordingBrowser() {
  const authenticated = [];
  return {
    authenticated,
    browser: {
      createBrowserContext: async () => ({
        newPage: async () => ({
          authenticate: async (auth) => {
            authenticated.push(auth);
          },
        }),
        close: async () => {},
      }),
    },
  };
}

/** The password segment that pins one IPRoyal exit node. */
const sessionIn = (password) => /_session-([^_]*)/.exec(password)?.[1] ?? null;

describe('newIsolatedPage exits', () => {
  /** A sticky IPRoyal proxy: one exit node per session id, held for five minutes. */
  const STICKY = 'http://user:secret_country-it_session-hFtcrtN8_lifetime-5m@geo.iproyal.com:12321';

  /**
   * Launch the browser stub as a real run would, so the proxy url is remembered against it.
   *
   * @param {string} proxyUrl
   * @returns {Promise<{browser: any, authenticated: any[]}>}
   */
  async function launched(proxyUrl) {
    const { browser, authenticated } = recordingBrowser();
    launchMock.mockReset();
    launchMock.mockResolvedValue(browser);
    return { browser: await launchBrowser('https://www.immobiliare.it/', { proxyUrl }), authenticated };
  }

  it('authenticates a page with the credentials the browser was launched with', async () => {
    const { browser, authenticated } = await launched(STICKY);

    const opened = await newIsolatedPage(browser);

    expect(authenticated).toEqual([{ username: 'user', password: 'secret_country-it_session-hFtcrtN8_lifetime-5m' }]);
    expect(opened.exitRotated).toBe(false);
  });

  it('asks IPRoyal for a new exit by writing a session id it has not seen', async () => {
    const { browser, authenticated } = await launched(STICKY);

    const first = await newIsolatedPage(browser, { freshExit: true });
    const second = await newIsolatedPage(browser, { freshExit: true });

    expect(first.exitRotated).toBe(true);
    expect(second.exitRotated).toBe(true);
    const sessions = authenticated.map((auth) => sessionIn(auth.password));
    expect(new Set([...sessions, 'hFtcrtN8']).size).toBe(3);
    // Everything else the password says stays as it was: a rotation must not move the exit country.
    for (const auth of authenticated) {
      expect(auth.username).toBe('user');
      expect(auth.password).toMatch(/^secret_country-it_session-[A-Za-z0-9]{8}_lifetime-5m$/);
    }
  });

  it('leaves a rotating IPRoyal password alone, because every request already gets a new exit', async () => {
    const { browser, authenticated } = await launched('http://user:secret_country-it@geo.iproyal.com:12321');

    const opened = await newIsolatedPage(browser, { freshExit: true });

    expect(opened.exitRotated).toBe(true);
    expect(authenticated).toEqual([{ username: 'user', password: 'secret_country-it' }]);
  });

  it('says so when the proxy is not one whose exit can be steered', async () => {
    const { browser, authenticated } = await launched('http://user:secret@proxy.example.com:8080');

    const opened = await newIsolatedPage(browser, { freshExit: true });

    expect(opened.exitRotated).toBe(false);
    expect(authenticated).toEqual([{ username: 'user', password: 'secret' }]);
  });

  /** Reading the exit address of a refused request has to leave from the address that was refused. */
  it('reuses credentials handed in rather than rotating again', async () => {
    const { browser, authenticated } = await launched(STICKY);

    const refused = await newIsolatedPage(browser, { freshExit: true });
    await newIsolatedPage(browser, { auth: refused.auth });

    expect(authenticated[1]).toEqual(refused.auth);
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
