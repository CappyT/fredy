# Fredy, Italy fork

This fork of [orangecoding/fredy](https://github.com/orangecoding/fredy) adds Italian providers
and a few other changes. Everything that exists only in the fork is documented
here, so that `README.md` and `AGENTS.md` stay identical to upstream. Read those first; this file
covers the differences.

## Providers

-   🏠 Scrapes **27 portals** across 🇩🇪 🇮🇹 🇦🇹 🇨🇭 🇪🇸 🇵🇹: ImmoScout24, Immowelt, Kleinanzeigen,
    WG-Gesucht, Immobiliare.it, Idealista, Casa.it, Subito, Tecnocasa, willhaben, Flatfox, Homegate
    and [15 more](./doc/providers.md)

Fredy ships with 27 providers. The German ones are listed in [Providers & scraping](./doc/providers.md);
the rest are offered Italy first:

The fork adds Immobiliare.it, Homegate and ImmoScout24.ch to upstream's 24. `README.md` and
`doc/providers.md` stay identical to upstream, so they still say 24; the fork's count lives here.

**🇮🇹 Italy** · Immobiliare.it · Idealista · Casa.it · Subito · Tecnocasa · Tecnorete  
**🇪🇸 Spain · 🇵🇹 Portugal** · Idealista  
**🇦🇹 Austria** · willhaben  
**🇨🇭 Switzerland** · Homegate · ImmoScout24.ch · Flatfox

### Idealista

Idealista uses the mobile APIs for idealista.com, idealista.it and idealista.pt.
The search URL determines the country.
The provider supports `/multi/` URLs and rejects unrelated domains.
Searches with filters or categories unsupported by the APIs use Fredy's browser.
DataDome can block the browser fallback.
See the [provider documentation](./reverse-engineered-idealista.md) for supported endpoints and filters.

### Immobiliare.it

Immobiliare.it uses the Android app's search API first.
That API answers a place filtered search over plain HTTP and costs no browser.
The provider translates the pasted search URL into the API's own query, and resolves the place
through the app's geography service.
The API carries a DataDome guard whose challenge depends on the exit: it can answer 403.
A refused read is asked again from a new proxy exit, up to three times, and only then is a solvable
`fe` challenge sent to the solver. A challenge the solver cannot answer falls back to the website.
The website search endpoint is read in the job's browser: it answers a plain http client with a
DataDome `bv` challenge, whatever the exit address.
The browser is refused as well from some exits. A refused read is asked again from a new proxy exit,
up to three times, and only then is a `fe` challenge sent to the solver.
The cookie the solver answers is bound to the configured exit, so the read carrying it leaves from
the configured credentials.
Searches the API cannot express use the same browser to render the page.
The provider reads up to twenty pages.
See the [provider documentation](./reverse-engineered-immobiliare.md) for supported endpoints.

### Homegate

Homegate uses the mobile API of its Android app, because the website refuses a plain client.
The provider reads the pasted search URL into the API's structured query: the offer type, the
category and the location slug, which it resolves through the portal's own location autocomplete.
The provider uses `api.re.swissmarketplace.group` as its primary host. That host answers the search
and the location autocomplete with no cookie and no challenge, and returns the same inventory as
`api.homegate.ch` (measured 2026-09-16). It falls back to `api.homegate.ch`, where a `datadome`
cookie gets the search in, minted once by the solver and reused.
A read either host refuses is asked again from a new proxy exit, up to three times. Only the
fallback host may then buy a cookie: the primary host is never solved for.
The provider sends a non-empty `X-App-Id` on every request. The server does not validate the header,
so any non-empty value works, and its presence is what keeps the answer honest.
Without the header, search responses rewrite the values inside a listing and carry the wrong value set
for about 70 to 80 percent of the requests. On `api.homegate.ch` a `datadome` cookie is still needed
for access. The provider reads every page through `lib/services/smg/poison.js` as a safety net: a page
that carries the rewritten set is requested again, up to a small cap, and is dropped with a log line
when it stays rewritten, so no row is stored unchecked. See the DataDome data poisoning section in
[the provider documentation](./reverse-engineered-homegate.md).
The URL's `o` parameter decides the sort, and `dateCreated desc` is what the provider asks for when
the URL names none. The sort travels in the request body, beside the query.
The provider reads up to five pages of twenty listings.
See the [provider documentation](./reverse-engineered-homegate.md) for the query fields and the response model.

### ImmoScout24.ch

ImmoScout24.ch uses the mobile API of its own app, `api.immoscout24.ch`.
The search URL a user pastes is translated into a structured query, and its place is resolved
through the portal's location autocomplete.
The provider sends a non-empty `X-App-Id` on every request. The server does not validate the header,
so any non-empty value works, and its presence is what keeps the answer honest.
The search endpoint answers a request without a `datadome` cookie with a challenge, so the cookie
comes from the fork's solver, `lib/services/datadome.js`.
A refused read is asked again from a new proxy exit, up to three times, before the solver is asked.
Without a capsolver key and a proxy the read stays refused, like any other blocked read.
ImmoScout24.ch shares the Homegate platform, so a request without the header carries the same rewrite;
the provider keeps `lib/services/smg/poison.js` as a safety net.
The provider reads up to five pages.
See the [provider documentation](./reverse-engineered-immoscout24ch.md) for supported endpoints and
filters.

## Swiss francs

Prices are shown in the currency they were advertised in. Flatfox serves Switzerland, so its listings
are in Swiss francs (CHF). Every other provider is in euros. Nothing is converted, so there is no
exchange rate to fetch and none to go out of date.

- **Where it shows.** Notifications, MCP answers and the web interface label a franc price in
  francs: the listings, the map and its price filter, the listing detail, the price per m², the
  price history and the price change badge.
- **What it keeps apart.** The market benchmark compares a listing only with listings in the same
  currency, so a flat in Basel is not measured against rents across the German border. The dashboard
  medians use the currency most of your priced listings are in, and name it.
- **What it leaves out.** The finance tools use a German mortgage and euro thresholds. Franc listings
  get no affordability verdict, no costing, no calculator shortcut, and they are skipped by the
  affordability filter and scan. External price observations are not sent for jobs whose listings
  are mostly in francs.
- **Job filter.** The maximum price applies to each listing in its own currency. The job form shows
  the currencies of the selected providers next to the field, for example `CHF` for a search on
  Flatfox only, or `€ / CHF` for a search across the border.

Listings stored before this change are labelled with their currency on the next start. A franc
listing among them also has its market median measured again against franc listings only.

## Proxy

The proxy url in **Administration -> Execution -> Proxy URL** (or `FREDY_PROXY_URL`) carries every
call to a portal, not only the headless browser. This replaces what
[Providers & scraping](./doc/providers.md) says about the proxy reaching browser providers alone.

- **Through the proxy.** The headless browser, the search and detail apis the api-based providers
  read (Immobiliare.it, Idealista, Casa.it, Subito, willhaben, Flatfox, Immoscout, ...), the listing
  images, and the alive check. They all use the global `fetch`, and
  `lib/services/http/outboundProxy.js` installs the proxy as undici's global dispatcher.
- **Direct.** Notifications (Telegram, ntfy, Slack, e-mail, the HTTP webhook), geocoding,
  connectivity, transit, the version check and telemetry. They use `node-fetch`, which ignores the
  global dispatcher, so a metered residential proxy carries portal traffic only. The HTTP
  notification adapter uses the global `fetch` and asks for the direct dispatcher explicitly.
- **Tests.** An upstream test that mocks `node-fetch` for a portal call also has to stub the global
  `fetch`, as `test/services/listings/listingActiveTester.test.js` does.
- **Schemes.** `http://`, `https://`, `socks4://`, `socks5://`, with optional `user:pass@`. A socks
  proxy is dialed through the `socks` package, because undici's `ProxyAgent` speaks HTTP CONNECT
  only. An unusable url is logged and the previous proxy stays in force: a scrape that fails is
  better than one that silently leaves from the server's own IP.
- **When it takes effect.** At startup, and on every save of the settings page, with no restart.
- **IPRoyal.** IPRoyal reads its per-request settings out of the proxy password, as
  `<password>_country-ch_session-hFtcrtN8_lifetime-5m`. When the host is `iproyal.com`, the settings
  page shows a country picker, a rotating/sticky switch and a lifetime in minutes, and writes them
  into that password; a password with no suffix rotates on every request. The countries offered are
  the ones the configured providers serve. `ui/src/services/proxy/iproyal.js` parses and rewrites the
  password, and carries through what the form knows nothing about, such as a city or `streaming`. No
  other proxy provider gets this: the same wishes are spelled differently everywhere else, so the
  controls stay hidden rather than writing a password that quietly does nothing.
- **Rotating an exit mid-run.** A session id IPRoyal has not seen starts a new session on a new exit
  node, with no lifetime to wait out. Both read paths write one into the password and leave from the
  new address:
  - the browser, through `newIsolatedPage(browser, { freshExit: true })` in
    `lib/services/extractor/puppeteerExtractor.js`, which authenticates one browser context with it;
  - `fetch`, through `rotatedExitDispatcher()` in `lib/services/http/outboundProxy.js`, which builds
    a dispatcher for the rewritten url. It carries one request, as `fetch(url, { dispatcher })`, and
    is closed once that answer has been read; every other call keeps the installed dispatcher.

  A password with no session segment already rotates per request, so a fresh context and a plain
  resend are each a new exit without a rewrite. Any other proxy, and no proxy, cannot be steered: the
  read is asked again once from the address it has and the log line says the exit could not be
  rotated. The backend reads the password with `lib/services/proxy/iproyal.js`, a copy of the form's
  rules, because the browser may not import out of `lib/`. `test/ui/iproyalInSync.test.js` fails when
  the two copies disagree.

## For coding agents

Additions to [AGENTS.md](./AGENTS.md), which applies here unchanged.

### Key services

| Service | Location | Notes |
|---|---|---|
| Currency | `lib/utils/currency.js`, `ui/src/services/price/currency.js` | Country to currency table, formatting, and the euro-only checks. The two tables must match, `test/ui/currencyInSync.test.js` enforces it. The pipeline stores `listings.currency` (migration `900.listing-currency.js`); `lib/services/listings/currencyBackfill.js` fills older rows at startup. SQL reads a NULL currency as `EUR`. The listing detail formats its prices in `ui/src/views/listings/listingFacts.js` and passes the currency to the price history in `components/ListingKeyFacts.jsx`. `formatPricePerSqm` takes the currency as its last argument, after upstream's `withUnit` |

### Bot protection

Upstream treats a challenge as a failed read. This fork keeps that default, with one exception: a
DataDome challenge on a portal the fork reads through an api is solved with a paid service
(capsolver), and the `datadome` cookie it returns is reused.

- The solver is off unless an api key is set, in **Administration -> Execution -> Capsolver API key**
  or in `CAPSOLVER_API_KEY` for a deployment that keeps it in a secret store, and a proxy is
  configured. Without both, every provider behaves exactly as upstream: a blocked read is a failed
  read.
- There is one proxy, the one the scrape uses. Capsolver refuses a DataDome task without a proxy, so
  the solve is sent the same one, rewritten as the `host:port:user:pass` capsolver reads. It reads it
  as an HTTP proxy, so a socks-only proxy scrapes but cannot solve.
- The cookie is not bound to the address that earned it: one solved from another exit node is
  accepted, as measured on the Swiss apps. It is not bound to the user agent either: a cookie minted
  under a Chrome 141 agent was accepted on a request carrying a different agent (measured
  2026-09-16). The browser still navigates under `SOLVE_USER_AGENT`, the agent capsolver solves with.
- The cookie is kept on disk beside the database (`datadome-tokens.json`, or `FREDY_DATADOME_STORE`)
  with the `Max-Age` the challenge stated, so a restart does not pay for a solve twice.
- A solve is paid for, so a host is asked of capsolver at most once every ten minutes, and two jobs
  refused at the same moment share one solve. A search that keeps being refused fails the read
  instead of buying a solve for each of its twenty pages.
- Only DataDome is handled this way. The other guards the fork meets stay unsolved.
- `lib/services/datadome.js` holds the whole mechanism, and `lib/services/idealista/idealistaSearch.js`
  is what uses it: it hands a token to the browser fallback before it navigates.

**What a refused read does.** A refusal has two remedies, and they are tried in the order of what
they cost: another exit node up to three times, then one solve for a `fe` challenge. There are two
copies of that policy, one per read path, because a read is made either in the run's browser or
through `fetch`:

- **In the browser.** `requestApiPage` in `lib/provider/immobiliare.js`. The website endpoint of
  Immobiliare.it answers a plain http client `bv`, whatever the exit address and whatever the user
  agent, so that read is made in the run's browser. It earns a `fe` from some exits, which is
  solvable. Each read takes a browser context of its own, and the cookie is set on the page before it
  navigates.
- **Through `fetch`.** `readThroughGuard` in `lib/services/http/guardedRead.js`, used by
  `lib/provider/homegate.js`, `lib/provider/immoscout24ch.js` and
  `lib/services/immobiliare/appApi.js`. A rotated read leaves through a dispatcher of its own, which
  is closed once its answer has been read; the read carrying a solved cookie leaves through the
  configured proxy. A host the caller does not solve for - Homegate's primary host - still gets the
  exits. A refusal that is not DataDome, a 422 say, is handed back at once: it says the same from
  every address.

Each refusal is a WARN naming the status, the challenge kind, the page and what is tried next. The
ERROR is the caller's, once, when nothing rescued the read.

The challenge has to be the `fe` kind. A `bv` challenge means the asking IP is blocked, which no
cookie fixes; capsolver refuses it. Only a different exit address helps, which is why both paths
rotate the exit before they ask the solver anything.

`reverse-engineered-immobiliare.md` and `reverse-engineered-idealista.md` record where each portal's
challenge was measured.

## Syncing with upstream

- Preview conflicts before merging: `git merge-tree --write-tree --name-only master upstream/master`
  prints the merged tree followed by the conflicted files, and exits 1 when there are any.
- Sync on every upstream release, so each merge stays small.
- Before merging, adopt upstream's squash-merged version of our own PRs, so the fork does not keep
  its copy of the change next to upstream's.
- Start upstream-bound work on an `upstream-pr/*` branch cut from `upstream/master`, then bring the
  same commit into `master`.
- Put fork code in fork-only files and small hooks, and fork documentation in this file. Never
  append fork entries at the end of upstream lists, locale files or import lines: upstream appends
  there too.
- New fork migrations use a reserved high number range (e.g. `900.`) and must be idempotent. Never
  rename an applied migration: `schema_migrations` is keyed by the file name.
- After each sync, record the divergence of upstream files below. Added and deleted files are
  excluded, so fork-only files do not count:
  `git diff --numstat --no-renames --diff-filter=MD upstream/master master | awk '{a+=$1; d+=$2; n++} END {print a, d, n}'`

### Divergence log

| Date | Fork commit | Upstream | Lines added | Lines deleted | Files |
|---|---|---|---|---|---|
| 2026-09-13 | `620c77e` | `b7c7e68` (27.6.1) | 2719 | 285 | 79 |
| 2026-09-14 | `2349cc9` | `b7c7e68` (27.6.1) | 2768 | 290 | 80 |
| 2026-09-14 | `cda6d47` | `b7c7e68` (27.6.1) | 2611 | 217 | 72 |
| 2026-09-15 | `e8e1cda` | `45f42ad` (28.1.0) | 2118 | 190 | 64 |
| 2026-09-19 | `2772bb7` | `ab43e56` (28.4.0) | 2869 | 257 | 91 |
| 2026-09-23 | `7583ff2` | `4662af2` (28.5.0) | 2922 | 262 | 96 |
| 2026-09-23 | `89e7063` | `1d0c3d7` (29.0.0) | 2931 | 281 | 99 |
