/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { Agent, ProxyAgent, getGlobalDispatcher } from 'undici';
import http from 'node:http';
import net from 'node:net';

import {
  createOutboundDispatcher,
  getDirectDispatcher,
  resetOutboundProxyForTests,
  syncOutboundProxy,
} from '../../../lib/services/http/outboundProxy.js';

const HTTP_PROXY = 'http://user:pass@proxy.example:12321';
const SOCKS_PROXY = 'socks5://user:pass@proxy.example:1080';

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

/** Start a server on a free loopback port. @returns {Promise<number>} The port. */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * The claim the unit tests above cannot make: a plain `fetch`, written nowhere near this module,
 * leaves through the configured proxy. Everything here is loopback, so the test needs no network.
 */
describe('a fetch under the proxy', () => {
  /** What the proxy was asked to reach, as `host:port`. @type {string[]} */
  const asked = [];

  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('origin');
  });

  // undici tunnels even a plain http target, so CONNECT is the only method that has to work here.
  const proxy = http.createServer((_req, res) => {
    res.writeHead(501);
    res.end();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    asked.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });

  afterAll(() => {
    origin.close();
    proxy.close();
  });

  it('reaches the target through the proxy, and directly once the proxy is removed', async () => {
    const originPort = await listen(origin);
    const proxyPort = await listen(proxy);

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
