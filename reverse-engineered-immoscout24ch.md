# Reverse Engineered ImmoScout24.ch's Mobile API

## What is ImmoScout24.ch?

ImmoScout24.ch is one of the two large Swiss real estate portals, alongside Homegate. It lists
apartments and houses for rent and for sale in German, French, Italian and English. It belongs to
SMG Swiss Marketplace Group, the same group that owns Homegate and Flatfox.

## Why do we do this?

The website sits behind the same DataDome bot protection as Homegate, which rules out web scraping.
The mobile app talks to a separate API host. This file documents what the app sends and reads, read
out of the APK and verified against the live server on a rooted device. The platform module
`group.swissmarketplace.**` is shared with the Homegate app, so the deep details of the shared
contract live in [reverse-engineered-homegate.md](reverse-engineered-homegate.md) and are not
repeated here. This file lists the Swiss app's own values and the places where it differs.

## How this was obtained

- App: ImmoScout24 Svizzera `6.3.0` (versionCode `6300000`), package `ch.immoscout24.ImmoScout24`,
  from Google Play.
- Decompile: `jadx 1.5.6`. App code under `group.swissmarketplace.**`.
- The request signing library is byte identical to Homegate's:
  `lib/arm64-v8a/libndk.so`,
  sha256 `2787b035dc75c81c4b2e4a40553aae5525aec557cd60fe69d707687dd787c8da`.

## Differences from Homegate

| What | Homegate | ImmoScout24.ch |
|---|---|---|
| API host | `https://api.re.swissmarketplace.group` (primary), `https://api.homegate.ch` (fallback) | `https://api.immoscout24.ch` |
| Test host | `https://apitest.homegate.ch` | `https://apitest.immoscout24.ch` |
| OAuth host | `https://homegate.ch` | `https://immoscout24.ch` |
| OAuth client id | `lU7SBprOA383MV4TCsRfP9wUPc4JAcy1` | `X2H86FJco6eegQirHhkYd9sZtXqzDyTV` |
| Session transfer audience | `urn:homegate.ch:session_transfer` | `urn:immoscout24.ch:session_transfer` |
| `User-Agent` | `homegate.ch.nextgen App Android/13.3.0` | `immoscout24.ch.nextgen App Android/6.3.0` |
| `X-App-Version` | `Homegate/13.3.0(13300000)/Android/<sdk>` | `Immoscout24/6.3.0(6300000)/Android/<sdk>` |
| DataDome captcha origin | `https://homegate.ch` | `https://immoscout24.ch` |

Identical to Homegate, and documented there:

- the OTP signature scheme for `X-App-Id` / `X-App-Time`, including its fallback values
- the DataDome SDK and its client side key `F366DD7CF4DB76FA9B54F971FAB24F`
- the OAuth flow, scopes `openid profile email offline_access`, redirect `homegate://login/redirect`
  (the redirect scheme is shared, not renamed per portal)
- every endpoint path, request and response model
- the query DSL of `POST /search/listings` and the response shape
- the `srp-list` / `srp-map` fieldsets, page size 20, and `maxFrom`
- the optional session: search goes out without `Authorization` when logged out

## Endpoints

Same shared surface as Homegate, plus Swiss additions. The search and listing endpoints are
identical:

| Method and path | Purpose |
|---|---|
| `POST /search/listings-by-url` | run a search given a full web search URL |
| `POST /search/listings` | run a search given a structured query |
| `GET /listings/listing/{listingId}` | one listing, full detail |
| `GET /listings/listings?ids={a,b}&fieldset={...}` | batch hydrate listings |
| `GET /geo/locations?lang={de}&name={...}` | location autocomplete |
| `GET /geo/locations-by-id?ids={...}` | resolve location ids |
| `GET /userinfo` | current account |
| `POST /oauth/token`, `POST /oauth/revoke` | token lifecycle |

Swiss additions the Homegate app does not ship, read from the CH app's own API modules:

| Method and path | Purpose |
|---|---|
| `GET /user-profile/profile` | tenant profile |
| `GET/POST /favourites-api/favourites`, `POST /favourites-api/favourites/sync` | favourites |
| `PUT /favourites-api/favourites/list/{listId}/listings/{listingId}` | add a listing to a list |
| `GET/POST/PATCH/DELETE /search-alerts/search-alerts` | search alerts, sent with header `X-App-Is-Wl: true` |
| `PUT /search-alerts/devices/{token}/updateToken` | push token update, also `X-App-Is-Wl: true` |
| `POST /search-alerts/price-drop-alerts` | price drop alerts |
| `GET /recommend-for-listing/recommend` | similar listings |
| `POST /recommend-for-search-alert/recommend` | recommendations for an alert |
| `GET /data-services/recommend-for-user/user-recommendation` | user recommendations |

## Search by URL

Identical body to Homegate:

```json
{
  "url": "https://www.immoscout24.ch/de/immobilien/mieten/ort-zuerich",
  "fieldset": "srp-list",
  "from": 0,
  "size": 20
}
```

A user pastes an `immoscout24.ch` search URL, in any of the four languages, and the API resolves it.
The response carries `from`, `size`, `total`, `results`, `maxFrom`, `query`, `sortBy`, `sortDirection`,
exactly as documented for Homegate.

## Notes for a Fredy provider

- One provider module per portal, like the Flatfox provider. Both declare `countries: ['ch']`, which
  flags them in the job form, bounds the map and scopes the geocoder.
- Both providers can share one response parser: the models are the same Kotlin classes in both apps,
  so the host and the `User-Agent` are the only per-provider values.
- Both providers send a non-empty `X-App-Id` on every request, so both get the honest data set (see
  "DataDome data poisoning" in the Homegate file).
- `price`, `size`, `rooms`, `publishedAt`, `image` map as documented in the Homegate file.
- Sorting rides in the request body as `sortBy: "dateCreated"`, `sortDirection: "desc"`.
- The listing's web URL is not in the response. The listing `id` and the language of the search URL
  are enough to build one, but the exact slug scheme has to be read off the live response first.

## Verified on device (live tests)

Same method as the Homegate file: requests were signed inside the CH app process with its own copy of
`libndk.so` and the app's own `otp_rsa_key` pair, then sent from the device with `HttpURLConnection`.
The app was driven through onboarding and a Zurich rental search with UI automation. The live in-app
search returned 1,248 listings, and all runs were logged out, so no request carried `Authorization`.

App values read live on this device (per install values will differ):

| Value | ImmoScout24.ch |
|---|---|
| `User-Agent` | `immoscout24.ch.nextgen App Android/6.3.0` |
| `X-App-Version` | `Immoscout24/6.3.0(6300000)/Android/37` |
| device id | `f8dd8602a9a` |
| `X-App-Id` | 26 digit numeric string, changes per request |
| `X-App-Time` | 36 to 37 chars, base64-like, changes per request |

Results:

| Test | Result |
|---|---|
| Signed fresh `GET /geo/locations?lang=de&name=Zuerich` | 200, 67 locations |
| Fallback headers: `X-App-Id: ""` and plain `X-App-Time` millis | 200 |
| No `X-App-Id` / `X-App-Time` at all | 200 |
| Signed `POST /search/listings`, geoTag resolved live, RENT, APARTMENT_OR_HOUSE, `dateCreated desc`, size 20, plus `datadome` cookie | 200, 1252 listings |
| Same body, `datadome` cookie only, no X-App headers | 200, 1252 listings. Access only: without `X-App-Id` the rows are poisoned |
| Signed `POST /search/listings` without cookie | 403, DataDome challenge JSON |
| Signed `GET /listings/listings?ids=...&fieldset=srp-list` plus cookie | 200 |

The geoTag for the search came from the live `GET /geo/locations` response (`geo-city-zurich`). The
app's own request used the same query shape with `sortBy: "listingType"`, `sortDirection: "desc"`,
`size: 0`.

Conclusions, same as Homegate: the `datadome` cookie is the access gate for `/search/*` and
`/listings/*`, and `/geo/locations` is unprotected. The `X-App-Id` value is not validated, but its
presence decides the data set: a non-empty value gets the honest set and an empty or absent one gets
the rewritten set (see "DataDome data poisoning" in the Homegate file). The cookie for
`api.immoscout24.ch` sits in the CH app's `android.webkit.CookieManager`. A fresh signature was still
accepted after 90s, and a pair was accepted on a path it was not minted for, so the server does not
enforce the signature binding.

`X-App-Is-Wl` was not needed for `POST /search/listings`, the one endpoint a Fredy provider calls.
The white label alert endpoints were not tested.

Measured 2026-09-16: `size: 20` is accepted, `size: 1` answers 416 "Page size is not supported".
Still unknown: the maximum accepted `size` and rate limits. `POST /search/listings-by-url` was
answered after the user agent discovery: 163 for the bare Chiasso rental URL and 8 with four
filters, the same two counts the translated query answers, with identical rows.

The shared SMG platform rewrites the values inside a listing when the request sends no non-empty
`X-App-Id`: the same id answers an honest value set and a wrong one across identical requests, and
both `POST /search/listings` and `GET /listings/listing/{id}` do it. A non-empty `X-App-Id` of any
value gets the honest set. Measured on `api.immoscout24.ch`: without the header the honest set
answered 1 time out of 12 (the one honest row kept `prices.rent.net`), with a non-empty `X-App-Id` it
answered 12 times out of 12. The Homegate file records the full measurement under
"DataDome data poisoning". Both Swiss apps share this platform module, so the same self-referential
check applies to every ImmoScout24.ch response.

## Minting the cookie without the app

Measured 2026-09-15, same recipe as the Homegate file, which describes it in full. The CH specific
values are the ones the challenge carries: `referer=https://api.immoscout24.ch/search/listings` and
the same client key `F366DD7CF4DB76FA9B54F971FAB24F`, so one solver covers both portals.

Verified: with a Swiss residential proxy, a capsolver `DatadomeSliderTask` on the `t=fe` challenge,
and a replay through the same proxy session with the same `User-Agent` and `Cookie: datadome=...`,
`POST /search/listings` for Zurich answered 200 with 1256 listings. The response carries
`address.geoCoordinates` and `address.geoTags`, so the geocoding step can be skipped. The replay
carried no `X-App-Id`, so its rows are the rewritten set; a provider must send a non-empty
`X-App-Id` to get the honest set (see "DataDome data poisoning" in the Homegate file).

The same binding matrix as the Homegate file was measured: the cookie answered 200 on the minting IP
with a different Chrome version, on the minting IP with the app `User-Agent`, and on a second Swiss
residential IP with both user agents. All five combinations answered 200, so neither the IP nor the
`User-Agent` is enforced in the tested scope. The cookie carries `Max-Age=31536000`.

## How to verify

Same as the Homegate file: no TLS pinning, release builds trust only system CAs, so use the Frida
route on a rooted device. The CH app adds only its own values: host `https://api.immoscout24.ch`,
its `User-Agent` and `X-App-Version`, its device id, and its own `otp_rsa_key` entry in the hardware
Keystore. Read the working recipe there, in particular the four Frida 17 traps: load scripts through
the `frida` CLI, capture the PEM by hooking `generateOtp` instead of reading the Keystore, cast the
connection to `HttpsURLConnection` before setting the method, and use `setTimeout` instead of a
blocking sleep.
