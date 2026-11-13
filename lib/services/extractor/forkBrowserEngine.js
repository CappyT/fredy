/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Italy fork: whether this deployment asked for Clearcote.
 *
 * Upstream drives Clearcote wherever it has an open build. The fork stays on CloakBrowser unless
 * `FREDY_BROWSER_ENGINE=clearcote` is set, because its reads through the residential proxy depend
 * on CloakBrowser leaving proxy authentication to Puppeteer: `newIsolatedPage` authenticates every
 * context with `page.authenticate`, and that is how a refused read asks IPRoyal for a fresh exit
 * node. Clearcote hands the credentials to the engine's own `--proxy-auth` switch instead, so the
 * rotated credentials would not be guaranteed to reach the proxy. See ITALY.md.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function clearcoteOptedIn(env = process.env) {
  return (env.FREDY_BROWSER_ENGINE ?? '').trim().toLowerCase() === 'clearcote';
}
