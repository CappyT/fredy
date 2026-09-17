/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { Agent, ProxyAgent, getGlobalDispatcher } from 'undici';
import http from 'node:http';
import net from 'node:net';

import {
  canRotateExit,
  createOutboundDispatcher,
  getDirectDispatcher,
  resetOutboundProxyForTests,
  rotatedExitDispatcher,
  syncOutboundProxy,
} from '../../../lib/services/http/outboundProxy.js';

const HTTP_PROXY = 'http://user:pass@proxy.example:12321';
const SOCKS_PROXY = 'socks5://user:pass@proxy.example:1080';

/** A sticky IPRoyal proxy: the session id in the password is what pins one exit node. */
const STICKY_IPROYAL = 'http://user:secret_country-it_session-hFtcrtN8_lifetime-5m@geo.iproyal.com:12321';

afterEach(() => {
  resetOutboundProxyForTests();
  vi.unstubAllEnvs();
});

describe('createOutboundDispatcher', () => {
  it('returns nothing when no proxy is configured', () => {
    expect(createOutboundDispatcher('')).toBe(null);
  });

  it('speaks http CONNECT for an http proxy', () => {
    expect(createOutboundDispatcher(HTTP_PROXY)).toBeInstanceOf(ProxyAgent);
  });

  it('dials a socks proxy through a connector of its own', () => {
    const dispatcher = createOutboundDispatcher(SOCKS_PROXY);
    expect(dispatcher).toBeInstanceOf(Agent);
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent);
  });

  it('rejects a scheme neither the browser nor fetch can use', () => {
    expect(() => createOutboundDispatcher('ftp://proxy.example:21')).toThrow(/Unsupported proxy scheme/);
  });
});

describe('syncOutboundProxy', () => {
  it('routes fetch through the proxy and takes it off again', () => {
    const direct = getDirectDispatcher();

    expect(syncOutboundProxy({ proxyUrl: HTTP_PROXY }, {})).toBe(HTTP_PROXY);
    expect(getGlobalDispatcher()).not.toBe(direct);

    expect(syncOutboundProxy({ proxyUrl: '' }, {})).toBe('');
    expect(getGlobalDispatcher()).toBe(direct);
  });

  it('keeps the same dispatcher when the url did not change', () => {
    syncOutboundProxy({ proxyUrl: HTTP_PROXY }, {});
    const installed = getGlobalDispatcher();

    syncOutboundProxy({ proxyUrl: HTTP_PROXY }, {});
    expect(getGlobalDispatcher()).toBe(installed);
  });

  it('reads FREDY_PROXY_URL when the setting is empty', () => {
    expect(syncOutboundProxy({}, { FREDY_PROXY_URL: SOCKS_PROXY })).toBe(SOCKS_PROXY);
    expect(getGlobalDispatcher()).not.toBe(getDirectDispatcher());
  });

  it('keeps the working proxy when the new url is unusable', () => {
    syncOutboundProxy({ proxyUrl: HTTP_PROXY }, {});
    const installed = getGlobalDispatcher();

    expect(syncOutboundProxy({ proxyUrl: 'not a url' }, {})).toBe(HTTP_PROXY);
    expect(getGlobalDispatcher()).toBe(installed);
  });
});

describe('a request sent from another exit', () => {
  /**
   * The proxy url a dispatcher was built from. undici keeps it on a private symbol, which is the
   * only place a test can read it back.
   *
   * @param {any} dispatcher
   * @returns {string|null}
   */
  const proxyUrlOf = (dispatcher) => {
    for (const key of Object.getOwnPropertySymbols(dispatcher)) {
      const value = dispatcher[key];
      if (value != null && typeof value === 'object' && typeof value.uri === 'string') return value.uri;
    }
    return null;
  };

  it('can be steered for IPRoyal and for nothing else', () => {
    expect(canRotateExit()).toBe(false);

    syncOutboundProxy({ proxyUrl: HTTP_PROXY }, {});
    expect(canRotateExit()).toBe(false);

    syncOutboundProxy({ proxyUrl: STICKY_IPROYAL }, {});
    expect(canRotateExit()).toBe(true);
  });

  it('asks IPRoyal for a session it has not seen, keeping the rest of the password', async () => {
    syncOutboundProxy({ proxyUrl: STICKY_IPROYAL }, {});

    const dispatcher = rotatedExitDispatcher();
    const other = rotatedExitDispatcher();
    const url = proxyUrlOf(dispatcher);
    expect(url).toContain('_country-it_');
    expect(url).toContain('_lifetime-5m');
    expect(url).not.toContain('session-hFtcrtN8');
    expect(proxyUrlOf(other)).not.toBe(url);

    await dispatcher.close();
    await other.close();
  });

  it('builds nothing for a password that already rotates on every request', () => {
    syncOutboundProxy({ proxyUrl: 'http://user:secret_country-it@geo.iproyal.com:12321' }, {});

    expect(canRotateExit()).toBe(true);
    expect(rotatedExitDispatcher()).toBe(null);
  });
});

/** Start a server on a free loopback port. @returns {Promise<number>} The port. */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * The claim the unit tests above cannot make: a plain `fetch`, written nowhere near this module,
 * leaves through the configured proxy. Everything here is loopback, so the test needs no network.
 */
describe('a fetch under the proxy', () => {
  /** What each proxy was asked to reach, as `host:port`. @type {string[]} */
  const asked = [];
  const askedByTheOther = [];

  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('origin');
  });

  /**
   * A CONNECT proxy that records what it was asked for. undici tunnels even a plain http target, so
   * CONNECT is the only method that has to work here.
   *
   * @param {string[]} log where the targets are recorded
   * @returns {import('node:http').Server}
   */
  function connectProxy(log) {
    const server = http.createServer((_req, res) => {
      res.writeHead(501);
      res.end();
    });
    server.on('connect', (req, clientSocket, head) => {
      log.push(req.url);
      const [host, port] = req.url.split(':');
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
    });
    return server;
  }

  const proxy = connectProxy(asked);
  const otherProxy = connectProxy(askedByTheOther);

  /** The loopback ports, taken once: a server listens once and both tests share it. */
  let originPort;
  let proxyPort;
  let otherPort;

  beforeAll(async () => {
    originPort = await listen(origin);
    proxyPort = await listen(proxy);
    otherPort = await listen(otherProxy);
  });

  afterAll(() => {
    origin.close();
    proxy.close();
    otherProxy.close();
  });

  /**
   * The claim the rotation rests on: a dispatcher handed to one `fetch` carries that request, while
   * the installed one carries every other. Without it a rotated read would leave from the very exit
   * that refused it.
   */
  it('leaves through the dispatcher one request was given, and not the installed one', async () => {
    syncOutboundProxy({ proxyUrl: `http://127.0.0.1:${proxyPort}` }, {});
    const dispatcher = createOutboundDispatcher(`http://127.0.0.1:${otherPort}`);

    const answer = await fetch(`http://127.0.0.1:${originPort}/`, { dispatcher });
    expect(await answer.text()).toBe('origin');
    expect(askedByTheOther).toEqual([`127.0.0.1:${originPort}`]);
    expect(asked).toHaveLength(0);

    await dispatcher.close();
  });

  it('reaches the target through the proxy, and directly once the proxy is removed', async () => {
    syncOutboundProxy({ proxyUrl: `http://127.0.0.1:${proxyPort}` }, {});
    const proxied = await fetch(`http://127.0.0.1:${originPort}/`);
    expect(await proxied.text()).toBe('origin');
    expect(asked).toEqual([`127.0.0.1:${originPort}`]);

    syncOutboundProxy({ proxyUrl: '' }, {});
    const direct = await fetch(`http://127.0.0.1:${originPort}/`);
    expect(await direct.text()).toBe('origin');
    expect(asked).toHaveLength(1);
  });
});
