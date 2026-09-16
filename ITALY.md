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

Immobiliare.it uses its search API and geography service to resolve location URLs.
The search endpoint is read in the job's browser: it answers a plain http client with a DataDome
`bv` challenge, whatever the exit address. Searches that cannot be translated into API requests use
the same browser to render the page.
The provider reads up to twenty pages.
See the [provider documentation](./reverse-engineered-immobiliare.md) for supported endpoints.

### Homegate

Homegate uses the mobile API of its Android app, because the website refuses a plain client.
The provider reads the pasted search URL into the API's structured query: the offer type, the
category and the location slug, which it resolves through the portal's own location autocomplete.
The location endpoint is open; only the search endpoint sits behind DataDome.
A `datadome` cookie gets the search in, minted once by the solver and reused.
Sorting is `dateCreated desc` and travels in the request body.
The provider reads up to five pages of twenty listings.
See the [provider documentation](./reverse-engineered-homegate.md) for the query fields and the response model.

### ImmoScout24.ch

ImmoScout24.ch uses the mobile API of its own app, `api.immoscout24.ch`.
The search URL a user pastes is translated into a structured query, and its place is resolved
through the portal's location autocomplete.
The search endpoint answers a request without a `datadome` cookie with a challenge, so the cookie
comes from the fork's solver, `lib/services/datadome.js`.
Without a capsolver key and a proxy the read stays refused, like any other blocked read.
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

## For coding agents

Additions to [AGENTS.md](./AGENTS.md), which applies here unchanged.

### Key services

| Service | Location | Notes |
|---|---|---|
| Currency | `lib/utils/currency.js`, `ui/src/services/price/currency.js` | Country to currency table, formatting, and the euro-only checks. The two tables must match, `test/ui/currencyInSync.test.js` enforces it. The pipeline stores `listings.currency` (migration `900.listing-currency.js`); `lib/services/listings/currencyBackfill.js` fills older rows at startup. SQL reads a NULL currency as `EUR` |

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
  accepted, as measured on the Swiss apps. It is bound to the user agent, which is why the browser is
  made to use `SOLVE_USER_AGENT` before it navigates.
- The cookie is kept on disk beside the database (`datadome-tokens.json`, or `FREDY_DATADOME_STORE`)
  with the `Max-Age` the challenge stated, so a restart does not pay for a solve twice.
- A solve is paid for, so a host is asked of capsolver at most once every ten minutes, and two jobs
  refused at the same moment share one solve. A search that keeps being refused fails the read
  instead of buying a solve for each of its twenty pages.
- Only DataDome is handled this way. The other guards the fork meets stay unsolved.
- `lib/services/datadome.js` holds the whole mechanism, and `lib/services/idealista/idealistaSearch.js`
  is what uses it: it hands a token to the browser fallback before it navigates.
  `lib/provider/immobiliare.js` buys no token at all. Its endpoint answers a plain http client `bv`,
  whatever the exit address and whatever the user agent, and `bv` is not a challenge capsolver can
  be paid to solve, so the read is made in the run's browser instead.

The challenge has to be the `fe` kind. A `bv` challenge means the asking IP is blocked, which no
cookie fixes; capsolver refuses it and the read stays failed.

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
