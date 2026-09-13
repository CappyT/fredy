/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The proxy the browser is launched through.
 *
 * The admin setting wins when it holds a value. Otherwise `FREDY_PROXY_URL` supplies one, so a
 * container deployment can keep the credential in its secret store instead of in the database,
 * where the settings page would show it and save it back.
 *
 * @param {Record<string, any>|null|undefined} settings The global settings.
 * @param {Record<string, string|undefined>} [env] The process environment.
 * @returns {string} The proxy url, or an empty string for none.
 */
export function resolveProxyUrl(settings, env = process.env) {
  const configured = typeof settings?.proxyUrl === 'string' ? settings.proxyUrl.trim() : '';
  if (configured) return configured;
  return typeof env.FREDY_PROXY_URL === 'string' ? env.FREDY_PROXY_URL.trim() : '';
}
