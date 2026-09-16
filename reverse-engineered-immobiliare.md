# Reverse Engineered Immobiliare.it

Immobiliare.it is Italy's largest property portal. Its pages sit behind DataDome; the android app's
search api answers a plain client on most exits. This file records what was measured about both, and
about the app's geography service, which resolves the place a search url names.

The provider is `lib/provider/immobiliare.js`. The translation of a website search url into an app
api query is in `lib/services/immobiliare/appApi.js`; the translation into the website endpoint's own
criteria is in `lib/services/immobiliare/web-translator.js`.

## Two hosts

| Host                        | Serves                                                                               | Protected                                   |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `www.immobiliare.it`        | the website, and `/api-next/search-list/listings/`, which its pages call for results | the pages and, since 2026-09-15, the endpoint |
| `android-imm-v4.ws-app.com` | the android app's api: properties, and a geography service                           | detail and geography are not; the search api carries a guard whose effect depends on the exit |

The provider searches through the app api first: it answers a place filtered search over plain http
and costs no browser. The website's own endpoint, read in the run's browser, is the fallback. Places
are resolved through the app's geography service on the same host, and the ids it answers with are
the ones the website endpoint filters by.

## Reading a search url

A url says three things, and all three are read:

- the first path segment says what is on offer and on what terms - `lib/services/immobiliare/web-paths.js`
- the segments after it name the place - `lib/services/immobiliare/geography.js`
- the query string carries the filters, which travel to the endpoint untouched

Only the place needs a lookup. That is the whole reason a town search used to need a browser: the
endpoint filters by `idComune=7369` and the url says `erbusco`, and nothing but a rendered page
carried the number. The rendered page still does, in `__NEXT_DATA__`, under the react-query key
`real-estate-list`; that route is now the fallback.

The two consumers read this differently. The website endpoint takes the website's own parameter
names, so a filter this file has never seen still works and only `pag` is removed, being a property
of the request rather than of the search. The app api has a fixed vocabulary instead, so `appApi.js`
translates the filters it can express, joins repeated typologies into one value, and refuses the url
when a place filter names several values, because the api cannot express that either.

### The filters, and who validates them

The website's search form carries its whole vocabulary in a javascript chunk of the homepage
(`s1.immobiliare.it/_next/static/chunks/`, the module whose enum begins `CONTRACT="idContratto"`).
There are 56 of them:

```
idContratto idCategoria idTipologia prezzo prezzoMinimo prezzoMassimo superficie superficieMinima
superficieMassima locali localiMinimo localiMassimo camereDaLetto camereDaLettoMinimo
camereDaLettoMassimo bagni stato tipoProprieta fasciaPiano usoEdificio boxAuto riscaldamenti
balconeOterrazzo giardino classeEnergetica vista ascensore cantina piscina arredato lusso vacanze
perStudenti animali fumatore sistemaAllarmeVigilanza virtualTour aReddito noAste noAgenzie lowcost
seaView seaDistance keyword keywords tipologiaStanza tipologiaPostoLetto sessoInquilini
occupazioneInquilini fkLicenza fkAssociazione idFranchising otherFeatures criterio ordine __lang
```

They are not translated one by one, and they do not need to be: the endpoint is the website's own
and reads these very names. What matters is that **the endpoint validates them**. An unknown name
answers `Route not found`, and a value in a shape it does not expect answers 422 naming the field
it refused:

```
{"errors":[{"message":"Questo valore dovrebbe essere di tipo unknown.","code":null,"path":"energyEfficiencyId"}]}
```

That is the reason the provider treats a refusal as a url it could not read after all, and renders
the page instead of answering with nothing. A filter whose value domain is unknown therefore costs
a browser, never a silently wider search.

Confirmed as passing through untouched, by a count that moves when they are applied:
`prezzoMinimo`, `prezzoMassimo`, `superficieMinima`, `superficieMassima`, `localiMinimo`, `bagni`,
`ascensore`, `cantina`, `arredato`, `noAste`, `fasciaPiano[]`, `balconeOterrazzo[]`,
`idTipologia[]`, `boxAuto[]`.

### The category table

Each entry in `web-paths.js` was confirmed against the endpoint, which describes every search it
answers in `seoData.subtitle` - "appartamenti in vendita Roma". To confirm a new one, ask for it and
read that line back:

```
curl -s -H 'Accept: application/json' -H 'Referer: https://www.immobiliare.it/' \
  'https://www.immobiliare.it/api-next/search-list/listings/?idNazione=IT&idContratto=1&idCategoria=1&idComune=6737&path=%2Fvendita-case%2Froma%2F' \
  | jq '.seoData.subtitle, .count'
```

The id vocabularies come from the same chunk. Categories: residenziale 1, commerciale 2, turistico
3, stanze 4, nuove costruzioni 6, aste 14, palazzi 20, magazzini 21, garage 22, uffici 23, terreni
24, capannoni 25, negozi 26. Typologies: appartamento 4, attico-mansarda 5, box 6, casa
indipendente 7, palazzo 10, rustico-casale 11, villa 12, villetta a schiera 13, loft 31, negozio
55, ufficio 56, capannone 59, magazzino 61, stanza 81.

Confirmed: `vendita`/`affitto` are `idContratto` 1 and 2; `case` is `idCategoria=1` with no type;
`appartamenti`, `attici`, `case-indipendenti`, `ville` and `villette` add `idTipologia[]` 4, 5, 7,
12 and 13.

The endpoint reads `path` for routing and not for filtering: asking for `/affitto-attici/roma/` with
`idContratto=1` answers "attici in vendita Roma". The criteria are the search; the path only has to
be one the portal recognises.

The commercial categories are in the table too: `palazzi` 20, `magazzini` 21, `garage` 22, `uffici`
23, `terreni` 24, `capannoni` 25, `negozi` 26. Each was confirmed against the endpoint, because a
category that only reads as the obvious one is not: offices are 23, while 2 is the whole commercial
vertical and answers with houses under an office url. The app api accepts these categories as well.
A wrong entry here silently widens somebody's search, so an unconfirmed one is still left out and its
url is rendered instead.

The endpoint requires `idNazione`, `idContratto` and `idCategoria`; it will not infer them from
`path`, and it answers `Bad Request` without them. It validates `path` as well, answering
`Route not found` for a path it does not recognise - and for an unknown query parameter, which is
how `idMZona[]` was found and `idQuartiere[]` ruled out.

## The dates

The website's search endpoint carries no date - read an advert of its answer whole and there is
nothing to find, which is why the site can only show one on the detail page. The app's search payload
carries `creationDate` and `lastModified`. The android app's property detail carries them too, on the
same unprotected host its geography service sits on:

```
GET https://android-imm-v4.ws-app.com/b2c/v2/properties/<id>
```

No key, no token. The answer carries `creationDate` and `lastModified`, both epoch **seconds** -
the one unit conversion in the provider - and `soldTransactionDate`, which is about a sale that
already happened and is left alone. One request per *new* listing is what a run costs: the pipeline
enriches only what it has not stored yet. Fredy keeps the later of the two dates, because a
re-published advert is the portal's own notion of "newer".

## The geography service

`GET https://android-imm-v4.ws-app.com/b2c/v1/geography/autocomplete?query=<words>`

No key, no token, no session. It answers with matching places, each carrying the chain above it:

```json
[
  {
    "id": "10070",
    "type": 3,
    "label": "Città Studi, Susa",
    "parents": [
      { "id": "8042", "type": 2, "label": "Milano" },
      { "id": "MI", "type": 1, "label": "Milano" },
      { "id": "lom", "type": 0, "label": "Lombardia" },
      { "id": "IT", "type": -1, "label": "Italia" }
    ]
  }
]
```

`type` says the level, and each level is a parameter of the search endpoint:

| type | level    | parameter     |
| ---- | -------- | ------------- |
| -1   | nation   | `idNazione`   |
| 0    | region   | `fkRegione`   |
| 1    | province | `idProvincia` |
| 2    | city     | `idComune`    |
| 3    | quarter  | `idMZona[]`   |

These are the same ids the website uses. Erbusco is 7369 in the app's answer, in the listing payload
and in the criteria a rendered page reports.

The service ranks by relevance, and a name alone does not identify a place: "Brescia" comes back as
a province, as the city in it, and as a quarter of a town in Rimini. The url's grammar settles it -
one segment means the city, `<name>-provincia` means the province, two segments mean a quarter of
the town named first - so the level is chosen and not merely ranked. A label is qualified with
another place ("Città Studi, Susa"), so only the part before the comma is matched.

The other endpoint of that service, `/b2c/v1/geography/polygons`, answers with the outline of a
place as `points: [[lat, lng], ...]`, taking exactly one of `cityId`, `provinceId`, `regionId` and
`nationId`. It is not used, because the search endpoint filters by id and an outline is the less
exact of the two, but it is what a search by drawn area would want.

## The app's search api

`GET https://android-imm-v4.ws-app.com/b2c/v1/properties` answers a search without credentials. The
provider sends the app's whole header set, `immo-id` included (measured 2026-09-16; the api answers
even without `immo-id`, but a client that looks like the app is the one the guard is meant to pass):

```
user-agent: WSCommand3<Furious>|REL|PRD|1080,2400,2.625|26.14.0|ANDROID|Google Pixel 7a|17|PHO|2.0-01/09/2016-16:40|0|0
accept-language: it-IT
x-currency: EUR
x-measurement-unit: meters
immo-id: <uuid, one per install>
```

The dynatrace and sentry headers the app sends are telemetry and can be dropped. `/count` answers the
same search with the total alone. `start` is an offset, a page holds 20, and the answer is a
container, not a bare array:

```json
{ "list": [ ... ], "offset": 0, "count": 20, "totalActive": 5008 }
```

Its parameters are short and its filter names come in families - `ac2_*` for the property's own
attributes, `ac3_*` for what comes with it. The full vocabulary is in the app: unpack the apk, run
`strings` over `classes*.dex`, and grep for `ac2_`. That is how `ac2_noaste` and `ac3_bauto` were
found after guessing had failed.

The place filter is `c` (city), `pr` (province), `regionId` (region), `nationId` (nation) and `z2`
(quarter); an area is `points` (a polygon) or `lt`+`ln`+`radius`. The sort is `of` and `od`, and
`of=d&od=d` is the newest first. Measured 2026-09-16. A name the api does not read is ignored - a
probe of `idmc`, `idComune`, `mc`, `idc` for the place and `ord`, `criterio`, `sort` for the order
answers with all of Italy and an untouched order - and a value it does not read is ignored the same
way, `t=l` answering what `t=v` answers. Some names are validated instead: an unknown `of` answers
400.

Repeated keys are read in three different ways, and only one of them is what the website spells.
`tip` is a single comma-joined list: `tip=12,13` answers both typologies, while `tip=12&tip=13`
answers 400. `z2` takes one value and no list: `z2=a&z2=b` answers 400 and `z2=a,b` matches nothing.
The provider joins the typologies and refuses a url that names several quarters, so neither case is
narrowed in silence.

A map search translates into it exactly. `vrt=lat,lng;lat,lng` becomes a `points` polygon,
`idContratto` 1 and 2 become `t=v` and `t=a`, `idCategoria` becomes `cat`, `idTipologia[]` becomes
`tip` with the same numbers, `prezzoMinimo`/`prezzoMassimo` become `pm`/`px`,
`superficieMinima`/`superficieMassima` become `sm`/`sx`, and `localiMinimo`/`localiMassimo` become
`lm`/`lx`. The api also reads `ac2_noaste` and `ac3_bauto`, which the provider does not translate: a
filter outside its measured set makes the url fall back to the website, where the website's own
parameter names travel untouched.

The api does not rewrite the values inside a listing the way the Swiss platform does. Two calls with
the same query answer the same figures, and they agree with the website.

The search item is flat, and richer than the website's: `id`, `title`, `price.raw`, `topology` with
the surface and the rooms, `geography` with `geolocation`, `municipality`, `street`, `microzone` and
`zipcode`, `media.images` and `media.floorPlans`, and `creationDate` and `lastModified`. It names no
advert link, so the provider builds it from the id: `https://www.immobiliare.it/annunci/<id>/`, which
is the url the app's own share answers with.

The provider reads through this api first, and through the website's endpoint or a rendered page only
when the api cannot express the url or refuses it.

## DataDome

Measured 2026-09-15. The website endpoint above is behind DataDome now; a request without a
`datadome` cookie answers 403:

```
GET https://www.immobiliare.it/api-next/search-list/listings/?idNazione=IT&idContratto=1&idCategoria=1&idComune=8042&path=%2Fvendita-case%2Fmilano%2F
-> 403 {"url":"https://geo.captcha-delivery.com/captcha/?initialCid=...&hash=BCBF2FCE4AED082640C3D1753C3381&t=fe&..."}
```

The `hash` is the DataDome client key, and it is the same key the android app carries: the key is
`BCBF2FCE4AED082640C3D1753C3381` in the apk (`x00/g.java`, its `K()`), and the block page names it.
The `t` value decides solvability: `fe` is the challenge capsolver answers, `bv` means the asking IP
is the reason for the block.

What decides the challenge type is the client, not the address. Measured from one pod, same minute:

| Client | Exit | Answer |
|---|---|---|
| `fetch` (undici) | datacenter, and residential IT, CH, DE, FR (9 exits) | 403, `t=bv` |
| `fetch` with Chrome 137, 141 or 151 and full `sec-ch-ua` headers | residential IT | 403, `t=bv` |
| `fetch` carrying a `datadome` cookie a browser had just earned | the minting exit | 403, `t=bv` |
| CloakBrowser | residential IT | 200, the listings |

So the endpoint is read in the run's browser (`requestApiPage`). A `bv` challenge is not
one capsolver can be paid to solve, and the cookie a browser earns does not transfer to an http
client here, whatever user agent it copies.

Each read takes a browser context of its own. The website's own search page (`/vendita-case/...`)
answers 403 with an interstitial that does not resolve itself, headed or headless, and a context
that has been sent there is answered `t=it` on every later endpoint read. A fresh context is
answered the listings.

The android app's search api carries a DataDome guard of its own, and its challenge depends on the
exit. Measured 2026-09-16: one Italian residential exit answered 200, another answered 403 with the
`it` interstitial, and a datacenter exit answered 403 with the `fe` challenge, the kind capsolver
solves. A request whose parameter shape is wrong answers 400, not a challenge.

The provider reuses a solved cookie and offers a `fe` challenge to the solver, then falls back to the
website and its browser when the challenge cannot be solved. `lib/services/datadome.js` owns the
solve and caps its cost. The app earns its own cookie from its DataDome SDK (client key above), which
stores it in SharedPreferences `datadome_storage_BCBF2FCE4AED082640C3D1753C3381` under `PREF_COOKIES`,
with `Domain=.ws-app.com`. The detail api (`/b2c/v2/properties/<id>`) and the geography service
answer plainly, which is why the provider enriches and resolves through them without a token.
