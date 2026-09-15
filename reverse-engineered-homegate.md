# Reverse Engineered Homegate's Mobile API

## What is Homegate?

Homegate is the largest real estate portal in Switzerland. It lists apartments and houses for rent and
for sale, in German, French, Italian and English. It is owned by SMG Swiss Marketplace Group, the same
group that owns ImmoScout24.ch, Flatfox, Newhome and Urbanhome.

## Why do we do this?

The Homegate website sits behind DataDome bot protection. In testing it refused both a datacenter and a
residential connection, which is why no web scraping provider for it exists. The mobile app talks to a
different host with a different contract. This file documents that contract. The request models and
endpoints come from static analysis of the APK; the header behaviour was then verified against the live
server on a rooted device. See "Verified on device" for the live results.

## How this was obtained

- App: Homegate `13.3.0` (versionCode `13300000`), package `ch.homegate.mobile`, from Google Play.
- Decompile: `jadx 1.5.6`. App code lives under `group.swissmarketplace.**`, shared with the
  ImmoScout24.ch app.
- The request signing is done in a native library, `lib/arm64-v8a/libndk.so`
  (sha256 `2787b035dc75c81c4b2e4a40553aae5525aec557cd60fe69d707687dd787c8da`).
- Key classes:
  `group.swissmarketplace.api.endpoints.search.SearchApi`,
  `group.swissmarketplace.api.interceptors.SmgApiHeaderInterceptor`,
  `group.swissmarketplace.crypto.otp.OtpNativeLib`,
  `group.swissmarketplace.crypto.helper.OtpHybridEncryptionHelper`,
  `group.swissmarketplace.core.model.search.request.*`,
  `group.swissmarketplace.core.model.listing.*`.

## Base URLs

| Host | Purpose |
|---|---|
| `https://api.homegate.ch` | production mobile API |
| `https://apitest.homegate.ch` | test API, the default target of debug builds |
| `https://homegate.ch` | OAuth token endpoint host (`/oauth/token`, `/oauth/revoke`) |

The debug build reads an override from `SharedPreferences` key `api_base_url`.

## Endpoints

Declared in the Retrofit interfaces under `group.swissmarketplace.api.endpoints`:

| Method and path | Purpose |
|---|---|
| `POST /search/listings-by-url` | run a search given a full web search URL |
| `POST /search/listings` | run a search given a structured query |
| `GET /listings/listing/{listingId}` | one listing, full detail |
| `GET /listings/listings?ids={a,b}&fieldset={...}` | batch hydrate listings (cache header `Cache-Control: max-age=3600`) |
| `GET /geo/locations?lang={de}&name={...}` | location autocomplete |
| `GET /geo/locations-by-id?ids={...}` | resolve location ids |
| `GET /userinfo` | current account |
| `POST /oauth/token` | token exchange, refresh, session transfer |
| `POST /oauth/revoke` | revoke a token |

## Request headers

Set by `SmgApiHeaderInterceptor` on every request:

```
User-Agent: homegate.ch.nextgen App Android/13.3.0
X-App-Version: Homegate/13.3.0(13300000)/Android/<os-sdk-int>
X-App-Id: <otp-derived token>
X-App-Time: <otp-derived token>
Authorization: Bearer <access token>        (only when a session exists and the endpoint is @Authenticated)
```

`X-App-Version` is built as `Homegate/<versionName>(<versionCode>)/Android/<Build.VERSION.SDK_INT>`,
for example `Homegate/13.3.0(13300000)/Android/34`.

### The OTP signature scheme

`X-App-Id` and `X-App-Time` are not constants. They come from `libndk.so`:

```
native String generateOtp(Context, String ua, String xappVersion, String pathWithQuery,
                          String body, long millis, String deviceId, String publicKeyPEM)
```

1. The interceptor collects: the `User-Agent` string, the `X-App-Version` string, the request path with
   query string, the request body (empty string when there is none), the current time in millis, the
   device id and a PEM public key. The device id is a random string persisted in preferences
   (`DeviceIdHelper`).
2. The PEM key comes from `OtpHybridEncryptionHelper`: an RSA key pair named `otp_rsa_key` in the
   Android hardware Keystore, falling back to a software key pair. The app exports the public half as
   PEM and passes it to the native library.
3. The library returns a base64 blob. The app parses it as
   `[u32 len | otpData][u32 len | encKey][16B IV][u32 len | encTimeDevice][16B IV2]` and decrypts:
   the AES key with `RSA/ECB/PKCS1Padding` against its private key, then both payloads with
   `AES/CBC/PKCS7Padding`. The first plaintext is `X-App-Id`, the second is `X-App-Time`.
4. The server receives both in clear. The inputs include the URL and the body, so the tokens are
   per-request. The live server does not enforce the binding: a pair minted for one path was accepted
   on another path, and a 90s old pair was still accepted. With a valid `datadome` cookie the server
   also accepts requests with no `X-App-Id` and no `X-App-Time` at all.

Fallbacks, when the library fails, are built into the app itself and the request is still sent:

| Failure | `X-App-Id` | `X-App-Time` |
|---|---|---|
| no cached public key | `""` | `<millis>` |
| library returned empty | `""` | `<deviceId><millis>` |

Both fallbacks were accepted by the live server on `/geo/locations`. On `/search/*` the signature
headers are optional once a `datadome` cookie is present, so the fallback question does not matter
there.

### DataDome

`SmgDataDomeInterceptor` wraps every request in the DataDome mobile SDK:

- client side key: `F366DD7CF4DB76FA9B54F971FAB24F`
- captcha page: `https://homegate.ch`, solved in a WebView (`co.datadome.sdk.ChallengeActivity`)
- the SDK answers with a `datadome` cookie, which the app stores and sends with subsequent requests
- the interceptor is gated by feature flag `Feature.DataDome`, whose default is **on**

Live checks found the cookie in `android.webkit.CookieManager` under the `api.homegate.ch` domain.
The challenge answers from the API carry the same client key in their `hash` parameter, which
confirms the pairing.

## Authentication

The app uses OAuth 2.0 with PKCE:

| Value | Homegate |
|---|---|
| client id | `lU7SBprOA383MV4TCsRfP9wUPc4JAcy1` |
| grant types | `AuthorizationCode`, `RefreshToken`, session transfer |
| scopes | `openid profile email offline_access` |
| redirect | `homegate://login/redirect` |
| session transfer audience | `urn:homegate.ch:session_transfer` |
| token endpoint | `POST https://homegate.ch/oauth/token` |

Token response fields: `id_token`, `token_type`, `access_token`, `refresh_token`, `expiresInSeconds`.

The session is optional. A logged out app stores no tokens, and the search endpoints then go out
without `Authorization`. The server side requirement is unknown and has to be tested with a plain
request.

## Search by URL

`POST /search/listings-by-url` takes the web URL a user pasted. This is the endpoint a Fredy provider
wants: the job stores a `www.homegate.ch` search URL and the API resolves it.

```json
{
  "url": "https://www.homegate.ch/rent/real-estate-listings/city-zurich",
  "fieldset": "srp-list",
  "from": 0,
  "size": 20
}
```

- `fieldset` values seen in the app: `srp-list` (result list) and `srp-map` (map pins).
- The app pages with `from = (page - 1) * 20` and `size = 20`.
- The response carries a `maxFrom` field, which is the pagination ceiling.

## Structured search

`POST /search/listings` takes the same paging plus a query object and a sort:

```json
{
  "query": {
    "offerType": "RENT",
    "location": { "geoTags": ["..."], "radius": 5000 },
    "monthlyRent": { "from": 1000, "to": 2500 }
  },
  "sortBy": "dateCreated",
  "sortDirection": "desc",
  "from": 0,
  "size": 20,
  "trackTotalHits": true,
  "fieldset": "srp-list"
}
```

### Query fields

Read from `SearchCriteria` and the converter in `SearchConverterRepository` / `SearchCriteriaTagsRepo`:

| Query field | Shape | Notes |
|---|---|---|
| `offerType` | `"RENT"` / `"BUY"` | |
| `propertyType` | string | e.g. `APARTMENT`, `HOUSE_OR_CHALET_OR_RUSTICO`, `BUILDING_PLOT`, `PARKING_SPACE_OR_GARAGE`, ... |
| `propertySubTypes` | string[] | e.g. `APARTMENT`, `ATTIC_FLAT`, ... |
| `monthlyRent` | `{from, to}` | rent searches. The converter writes `priceRange` here or into `purchasePrice` depending on `offerType` |
| `purchasePrice` | `{from, to}` | buy searches |
| `yearlyRentPerSqmRange` | `{from, to}` | |
| `numberOfRooms` | `{from, to}` | |
| `surfaceLivingRange` | `{from, to}` | living space |
| `surfacePropertyRange` | `{from, to}` | lot size |
| `totalFloorSpace` | `{from}` | written from `surfaceUsableRange.from` |
| `singleFloorSpace` | `{to}` | written from `surfaceUsableRange.to` |
| `volumeRange` | `{from, to}` | cubage |
| `buildYearRange` | `{from, to}` | |
| `floorType` | number | `ground_floor` becomes `{from: 0, to: 0.5}`, anything else `{from: 1}` |
| `isPriceDefined` | boolean | |
| `availableDate` | text range | |
| `location` | object | see below |
| `facilitiesRequired` | string[] | see below |

### Location

Two shapes, both nested under `location`:

```json
{ "geoTags": ["..."], "radius": 5000 }
{ "polygon": [[[8.5417, 47.3769], [8.5450, 47.3770], ...]] }
```

- `geoTags` holds location ids as returned by `GET /geo/locations`.
- `polygon` is an array of polygons, each polygon is an array of rings, each ring is an array of
  `[lon, lat]` pairs. Coordinates are GeoJSON ordered: longitude first.
- The app removes `radius` and `geoTags` when a polygon is present. A search carries one or the other.

### Facility tags

The `facilitiesRequired` values, read from `SearchCriteriaTagsRepo` and the filter translations:

`HAS_BALCONY`, `ANIMALS_ALLOWED`, `IS_MINERGIE`, `HAS_ELEVATOR`, `WHEELCHAIRS_ALLOWED`, `NEWLY_BUILT`,
`BUILT_OLD`, `HAS_SWIMMING_POOL`, `HAS_PARKING_OR_GARAGE`.

Aliases the converter folds in: `HAS_GARAGE` and `HAS_PARKING_SLOT` become `HAS_PARKING_OR_GARAGE`,
`MINERGIE_CERTIFIED` and `MINERGIE_BUILT` become `IS_MINERGIE`.

### Sort

| `sortBy` | `sortDirection` | Meaning |
|---|---|---|
| `dateCreated` | `desc` | newest first, the app's "NewestFirst" option |
| `purchasePrice` | `asc` / `desc` | price, for buy searches |
| `monthlyRent` | `asc` / `desc` | price, for rent searches |
| `listingType` | `desc` | the app's default, top offers first |
| `exclusive` | `desc` | the app's "TenantPlus" option |
| `Place` | | declared without a `@SerialName`, wire spelling unverified |

## Response

`POST /search/listings-by-url` answers:

```json
{
  "from": 0,
  "size": 20,
  "total": 533,
  "results": [ { "$smgListing": "..." } ],
  "maxFrom": 500,
  "query": {},
  "sortBy": "listingType",
  "sortDirection": "desc"
}
```

### SmgListing

| Field | Type | Notes |
|---|---|---|
| `id` | string | listing id |
| `listing` | Listing | the full listing object |
| `listingType` | string | `PREMIUM`, `TOP`, `STANDARD`, `BASIC` |
| `listingCard` | object | `{size}` |
| `dateAdded` | long | client side marker |
| `isNewItem` | boolean | client side marker |
| `isFavorite`, `isOffline` | boolean | client state |
| `listerBranding` | object | branding of the lister |
| `agencyAgent` | object | agent when contacted through the app |
| `newConstructionData` | object | `{projectName, projectType, projectUrl}` |
| `districtName` | object | district localization |

### Listing

| Field | Type |
|---|---|
| `id` | string |
| `offerType` | `"buy"` / `"rent"` |
| `prices` | Prices, see below |
| `localization` | `{de, en, fr, it, primary}`, each an L10N block |
| `characteristics` | see below |
| `availableFrom` | date |
| `meta` | `{created, createdAt, schemaVersion, softwareName, updatedAt}` |
| `lister` | `{id, name, legalName, email, emailForRemFormat, mobile, phone, website, contacts, allowToContact}` |
| `contactForm` | object |
| `externalIds` | `{displayPropertyReferenceID, displayReferenceID, internalReferenceID, propertyReferenceID, platformListingId}` |
| `categories` | array |
| `platforms` | array |
| `valueAddedServices` | array |

`localization.primary` selects the language block. An L10N block holds:

| Field | Shape |
|---|---|
| `text` | `{title, description, translatedTitle, translatedDescription, translationStatus}` |
| `attachments` | `[{alt, description, publication, title, type, url}]`, `type` is `DOCUMENT`, `PLAN` or `SALES_BROCHURE` |
| `urls` | string[] |

### Prices

```json
{
  "currency": "CHF",
  "rent": { "net": 2100, "gross": 2300, "extra": null, "area": "ALL", "interval": "MONTH" },
  "buy":  { "price": 1250000, "extra": null, "area": "ALL" }
}
```

- `rent.interval` is one of `DAY`, `WEEK`, `MONTH`, `YEAR`, `ONETIME`.
- `area` refers to the area the price is per: `ALL`, `M2` or `KM2`.

### Characteristics

Every field is optional. The useful ones for Fredy: `numberOfRooms`, `livingSpace`, `yearBuilt`,
`yearLastRenovated`, `floor`, `hasBalcony`, `hasParking`, `isGroundFloor`, `isNewBuilding`.

Full list, as declared in the serializer:

```
areaSiaNf arePetsAllowed buildingFloorSize ceilingHeight craneCapacity cubage elevatorCapacity
floor floorLoad grossPremium hallHeight hasAttic hasBalcony hasBuildingLawRestrictions hasCableTv
hasCarPort hasCellar hasChargingStation hasConnectedBuildingLand hasDemolitionProperty
hasDishwasher hasDoubleCarPort hasDoubleGarage hasElevator hasFireplace hasFlatSharingCommunity
hasForeignQuota hasGarage hasGarageUnderground hasGardenShed hasGasSupply hasLakeView
hasLiftingPlatform hasMountainView hasNiceView hasParking hasPhotovoltaic hasPlayground
hasPowerSupply hasRailwayTerminal hasRamp hasSewageSupply hasSteamer hasStoreRoom hasSwimmingPool
hasThermalSolarCollector hasTiledStove hasTumbleDryer hasWashingMachine hasWaterSupply
isChildFriendly isCornerHouse isDilapidated isFirstOccupancy isGroundFloor isGroundFloorRaised
isGutted isInNeedOfRenovation isInNeedOfRenovationPartially isLikeNew isMiddleHouse
isMinergieCertified isMinergieGeneral isMinergie isModernized isNewBuilding isOldBuilding
isPartiallyRefurbished isProjection isQuiet isRefurbished isSecondaryResidenceAllowed
isShellConstruction isSmokingAllowed isSunny isUnderRoof isWellTended isWheelchairAccessible
lotSize numberOfApartments numberOfBathrooms numberOfFloors numberOfRooms numberOfShowers
numberOfToilets numberOfToiletsGuest onEvenGround onHillside onHillsideSouth livingSpace
totalFloorSpace singleFloorSpace yearBuilt yearLastRenovated
```

## Notes for a Fredy provider

- Input: the user pastes a `www.homegate.ch` search URL. Send it inside
  `POST /search/listings-by-url` with `{"fieldset":"srp-list","from":0,"size":20}`.
- The web URL carries its own filters, so the provider needs no parameter translation, unlike the
  ImmoScout24.de provider. Live tests rejected this path: `POST /search/listings-by-url` answered
  422 "not a SRP uri" for eight public `www.homegate.ch` search URL forms. Use the structured
  `POST /search/listings` instead and resolve the user's URL filters into the query yourself.
- Field mapping, subject to the live results in "Verified on device":
  `price` from `prices.rent.net` (fallback `prices.rent.gross`, matching Flatfox's precedence) or
  `prices.buy.price`; `size` from `characteristics.livingSpace`; `rooms` from
  `characteristics.numberOfRooms`; `publishedAt` from `listing.meta.createdAt`; `image` from the
  primary language's first `attachments` entry with an image URL.
- Sorting: the request body carries `sortBy`/`sortDirection`, not a URL parameter. `dateCreated`
  `desc` is the equivalent of `sortByDateParam` on the scraping providers.
- Both apps share this whole platform module. The ImmoScout24.ch differences are listed in
  [reverse-engineered-immoscout24ch.md](reverse-engineered-immoscout24ch.md).

## Verified on device (live tests)

Tests ran on a rooted Pixel 7a, Android 17 (SDK 37), Homegate app 13.3.0. Each signed request was
computed inside the app process with its own `libndk.so` and decrypted with the app's own
`OtpHybridEncryptionHelper`, then sent with `HttpURLConnection` from the device. All runs were logged
out, so no request carried `Authorization`. The datadome cookie was copied from
`android.webkit.CookieManager` inside the app process.

Observed header values:

| Header | Value |
|---|---|
| `User-Agent` | `homegate.ch.nextgen App Android/13.3.0` |
| `X-App-Version` | `Homegate/13.3.0(13300000)/Android/37` |
| `X-App-Id` | 26 digit numeric string, changes per request |
| `X-App-Time` | 36 to 37 chars, base64-like, changes per request |

Results:

| Test | Result |
|---|---|
| Signed fresh `GET /geo/locations?lang=en&name=Lugano` | 200, 12 locations |
| Same signature pair replayed on another path | 200. The pair is not bound to path or query |
| Fallback headers: `X-App-Id: ""` and plain `X-App-Time` millis | 200 |
| No `X-App-Id` / `X-App-Time` at all | 200 |
| No `User-Agent` (JVM default) | 200 |
| Signed `POST /search/listings` with the structured Lugano query | 403, DataDome challenge JSON |
| Signed `POST /search/listings-by-url` | 403, DataDome challenge JSON |
| Signed `GET /listings/listings?ids=...&fieldset=srp-list` | 403, DataDome challenge JSON |
| Fresh signature after a 90s wait | 200 (control) |
| The 90s old pair replayed | 200. No staleness rejection at 90s |
| Signed `POST /search/listings` plus `datadome` cookie | 200, 412 listings |
| `datadome` cookie only, no X-App headers | 200, 412 listings |
| `datadome` cookie only, no `User-Agent` | 200, 412 listings |
| Signed `GET /listings/listings` plus cookie | 200, full listing objects |
| Signed `POST /search/listings-by-url` plus cookie, public web URL | 422 "not a SRP uri" |

Corrections to the claims above:

- The OTP signature is not the gate. `/search/*` and `/listings/*` require a valid `datadome` cookie.
  With the cookie the server accepts requests with no `X-App-Id`, no `X-App-Time` and no app
  `User-Agent`. `/geo/locations` accepts plain requests with no cookie, no signature and no app
  `User-Agent`.
- `Authorization` is not required for the search endpoints without a session.
- The `datadome` cookie was not tied to the `User-Agent` in this test window. The cookie value comes
  from an app session; a plain HTTP client cannot mint one and gets a 403 challenge with a
  `geo.captcha-delivery.com` URL.
- The signature binding to path and body is not enforced server side, see the second and tenth rows.
- `/search/listings-by-url` rejects the public web search URLs. Eight forms were tried: full URLs
  with and without locale prefix, path only, German slugs, with and without query string. Full URLs
  answer 422 "not a SRP uri", partial paths answer 422 "Invalid URL". The accepted format was not
  determined. Build the structured query and use `POST /search/listings`.

Not run, so still unknown: maximum accepted `size`, rate limits, `from` beyond `maxFrom`, the wire
spelling of the `Place` sort value.

## How to verify

The app ships no TLS pinning (`network_security_config.xml` has only debug overrides), but release
builds do not trust user CAs. The proven route is Frida on a rooted device, and Frida 17 changes two
things against older guides: the Python bindings carry no Java bridge, so scripts must load through
the `frida` CLI (`frida -U -p <pid> -l script.js`).

1. Hook `OtpNativeLib.generateOtp` and log its arguments. This yields the full PEM public key and the
   device id without touching `java.security`, which resolves oddly under Frida.
2. In the app process, pick up live `OtpNativeLib` and `OtpHybridEncryptionHelper` instances with
   `Java.choose`, call `generateOtp(ctx, ua, xappVersion, pathWithQuery, body, millis, deviceId, pem)`
   and decrypt with `helper.b(raw)` into the `X-App-Id` / `X-App-Time` pair. Pass the captured PEM
   string, not a Keystore read.
3. Send requests with `java.net.URL` from the same process. Cast the connection first with
   `Java.cast(conn, Java.use('javax.net.ssl.HttpsURLConnection'))`: the `openConnection()` wrapper
   only exposes `URLConnection` methods and `setRequestMethod` fails with "not a function".
4. Copy the cookie with `android.webkit.CookieManager.getInstance().getCookie('https://api.homegate.ch')`
   and send it as the `Cookie` header.

Do not sleep on the script thread for staleness tests: the blocking sleep trips the Frida script load
timeout ("Failed to load script"). Use `setTimeout` for the delayed variants.

## Minting the cookie without the app

Measured 2026-09-15 through a Swiss residential proxy, without the app and without the OTP signature.

| Step | What happens |
|---|---|
| Request without a cookie | 403. JSON body `{"url": "https://geo.captcha-delivery.com/captcha/?...&t=fe&..."}`, header `x-dd-b: 1`. The `hash` field is the DataDome client key `F366DD7CF4DB76FA9B54F971FAB24F`, the same key the Android SDK carries |
| Challenge | `t=fe` is solvable. `t=bv` means the asking IP is the reason for the block and only an IP change helps, see `isSolveable` |
| Solve | capsolver task `DatadomeSliderTask` with the `captchaUrl`, a `User-Agent` from capsolver's fixed set (Chrome 137 to 151) and a residential proxy |
| Cookie | the solution is `datadome=...; Max-Age=31536000`, one year |
| Replay | same proxy session, same `User-Agent`, header `Cookie: datadome=...` answers 200 with the listings |

Results: 412 listings for Lugano on `api.homegate.ch`, 1256 for Zurich on `api.immoscout24.ch`. Both
portals answer the same client key, so one solver covers both.

Constraints, measured:

- The cookie is bound to neither the IP nor the `User-Agent` in the tested scope. Minted on one Swiss
  residential IP with one Chrome user agent, the same cookie answered 200 on the minting IP with a
  different Chrome version, on the minting IP with the app `User-Agent`, and on a second Swiss
  residential IP with both user agents. All five combinations answered 200, on both portals.
  Datacenter IPs and non Swiss IPs were not tested.
- One mint is therefore enough for a long time: the cookie carries `Max-Age=31536000`, so the
  on-disk store in `lib/services/datadome.js` holds it for a year and a run pays for a solve only
  when the endpoint refuses again.
- The mobile API does not check the OTP signature or the app `User-Agent` when the cookie is valid. A
  cookie minted by the web challenge from a desktop browser user agent is accepted. This is what makes
  a server-side provider possible, with no device and no app.
- `lib/services/datadome.js` already implements this flow: challenge detection, `DatadomeSliderTask`,
  `SOLVE_USER_AGENT`, the on-disk token store and the `t=bv` rejection. The two Swiss providers only
  need to call it and send the `Cookie` header.
- The listing response carries `address.geoCoordinates` and `address.geoTags` (`geo-city-...`,
  `geo-zipcode-...`, `geo-canton-...`), so the geocoding step can be skipped.
