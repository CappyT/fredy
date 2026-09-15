/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { Agent, ProxyAgent, buildConnector, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { SocksClient } from 'socks';
import { resolveProxyUrl } from '../proxyUrl.js';
import logger from '../logger.js';

/**
 * The dispatcher Node started with, kept so the proxy can be taken off again and so a caller that
 * must stay off the proxy has something to pass.
 */
const directDispatcher = getGlobalDispatcher();

/** The proxy url currently installed, an empty string for none. @type {string} */
let appliedProxyUrl = '';
/** The dispatcher built for {@link appliedProxyUrl}. @type {import('undici').Dispatcher|null} */
let appliedDispatcher = null;

/**
 * The dispatcher that talks to a host directly.
 *
 * The portals are what the proxy is paid for, so a caller reaching a service of the operator's own
 * (a webhook, a notification endpoint) passes this to stay off it.
 *
 * @returns {import('undici').Dispatcher}
 */
export function getDirectDispatcher() {
  return directDispatcher;
}

/**
 * An undici connector that opens the connection through a SOCKS proxy.
 *
 * undici's own `ProxyAgent` speaks HTTP CONNECT only, while the setting also accepts the socks url
 * Chrome takes. The socket the proxy hands back is given to the default connector as `httpSocket`,
 * which is what upgrades it to TLS for an https target.
 *
 * @param {URL} proxy The parsed proxy url.
 * @returns {import('undici').buildConnector.connector}
 */
function socksConnector(proxy) {
  const connect = buildConnector({});
  const type = proxy.protocol === 'socks4:' ? 4 : 5;
  const userId = proxy.username ? decodeURIComponent(proxy.username) : undefined;
  const password = proxy.password ? decodeURIComponent(proxy.password) : undefined;

  return async (options, callback) => {
    let socket;
    try {
      ({ socket } = await SocksClient.createConnection({
        proxy: { host: proxy.hostname, port: Number(proxy.port) || 1080, type, userId, password },
        command: 'connect',
        destination: {
          host: options.hostname,
          port: Number(options.port) || (options.protocol === 'https:' ? 443 : 80),
        },
      }));
    } catch (err) {
      callback(err, null);
      return;
    }
    return connect({ ...options, httpSocket: socket }, callback);
  };
}

/**
 * Build the dispatcher for a proxy url.
 *
 * @param {string} proxyUrl The proxy url, empty for none.
 * @returns {import('undici').Dispatcher|null} The dispatcher, or null when no proxy is configured.
 * @throws {Error} When the url is malformed or its scheme is none of http, https, socks4, socks5.
 */
export function createOutboundDispatcher(proxyUrl) {
  if (!proxyUrl) return null;

  const parsed = new URL(proxyUrl);
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return new ProxyAgent(proxyUrl);
  }
  if (parsed.protocol === 'socks4:' || parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
    return new Agent({ connect: socksConnector(parsed) });
  }
  throw new Error(`Unsupported proxy scheme "${parsed.protocol}". Use http, https, socks4 or socks5.`);
}

/**
 * Route the outgoing http calls through the configured proxy, or take the proxy off again.
 *
 * The portals read the scraper's IP before they read anything else, so the requests that go to them
 * without the browser - the search apis, the detail apis, the images, the alive check - have to
 * leave from the same address the browser leaves from. They all use the global `fetch`, so one
 * dispatcher covers them.
 *
 * A bad proxy url is logged and the previous setting is kept: an unreachable proxy is a failed
 * scrape, while silently falling back to the datacenter IP is the ban the proxy was bought against.
 *
 * @param {Record<string, any>|null|undefined} settings The global settings.
 * @param {Record<string, string|undefined>} [env] The process environment.
 * @returns {string} The proxy url in force, an empty string for none.
 */
export function syncOutboundProxy(settings, env = process.env) {
  const proxyUrl = resolveProxyUrl(settings, env);
  if (proxyUrl === appliedProxyUrl) return appliedProxyUrl;

  let next;
  try {
    next = createOutboundDispatcher(proxyUrl);
  } catch (err) {
    logger.error(`Ignoring the proxy url: ${err.message}`);
    return appliedProxyUrl;
  }

  setGlobalDispatcher(next ?? directDispatcher);

  const previous = appliedDispatcher;
  appliedProxyUrl = proxyUrl;
  appliedDispatcher = next;
  // The requests already on the old dispatcher are left to finish; close() only stops it taking new
  // ones. Not awaited, and a failure here changes nothing that matters.
  previous?.close?.().catch(() => {});

  logger.debug(next == null ? 'Outbound http calls go out directly.' : 'Outbound http calls go through the proxy.');
  return appliedProxyUrl;
}

/**
 * Reset the module to "no proxy installed". For tests.
 */
export function resetOutboundProxyForTests() {
  setGlobalDispatcher(directDispatcher);
  appliedProxyUrl = '';
  appliedDispatcher = null;
}
