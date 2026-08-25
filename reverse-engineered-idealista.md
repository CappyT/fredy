# Reverse Engineered Idealista's Mobile API

Idealista.it is the Italian arm of the Spanish portal. Its website sits behind DataDome, which no
headless browser clears, so Fredy used to read it through an external challenge-solving scrape
service. The android app talks to a different host, and that host serves JSON to a plain HTTPS
request. This file records what that api is, because none of it is documented and all of it was
measured.

The provider is `lib/provider/idealista.js`. The translation from a website search url into an api
search is in `lib/services/idealista/`.

## Hosts

| Host               | Serves                                                             | Protected |
| ------------------ | ------------------------------------------------------------------ | --------- |
| `app.idealista.it` | the app's JSON api - tokens, searches, the catalogue of locations  | no        |
| `mt1.idealista.it` | the map's tiles, the outline of every area, the tree of area codes | no        |
| `www.idealista.it` | the website, and the ajax endpoints its pages call                 | DataDome  |

Only the first two are used. The third is read through the challenge solver, and only for a search
the api cannot be asked for.

## Request signing

Every call carries:

- query parameters `k` (the client key `5b85c03c16bbb85d96e232b112ee85dc`) and `t` (a device id,
  any 16 hex characters, the same for the life of an install)
- headers `User-Agent`, `app_version` and `device_identifier`
- headers `Signature` and `seed`

`seed` is a fresh UUID per request. `Signature` is the lowercase hex of an HMAC-SHA256 over
`seed + METHOD + query + body`, where query and body are each their parameters sorted by name and
joined `name=value&name=value`, url-encoded as `java.net.URLEncoder` does it - a space becomes `+`,
and `* - _ .` are left alone.

The HMAC key is the ASCII string `bXBUUW5TODhKdFhENmQyRQ==`. It looks like base64 and is not: the
app uses those characters verbatim as the key bytes.

A token comes from `POST /api/oauth/token` with
`Authorization: Basic base64(urlencode(clientKey) + ":" + urlencode("idea;andr01d"))` and the form
body `grant_type=client_credentials&scope=write`. It lasts about twelve hours.

## Endpoints

| Path                                                     | Answers                                 |
| -------------------------------------------------------- | --------------------------------------- |
| `POST /api/oauth/token`                                  | a bearer token                          |
| `POST /api/3.5/it/search`                                | one page of adverts                     |
| `POST /api/3.5/it/search/locations`                      | one level of the catalogue of locations |
| `GET  https://mt1.idealista.it/19/paths/it/{code}`       | the outline of one area                 |
| `GET  https://mt1.idealista.it/19/tree/all-it-tree.json` | every area code, as a tree              |

`3.5` is the api version and `it` the country. `19` is the version of the tile set.

### How the accepted values were found

The api names them itself. A parameter sent with a value it does not accept is answered with the
list of the ones it does:

```
{"message":"Invalid value. Accepted values for order are: distance, size, rooms, floor, ratioeurm2,
 price, street, photos, modificationDate, publicationDate, weigh, priceDown,
 preservationTypeAndPrice, privateAds","httpStatus":400}
```

Whether a parameter is read at all is answered by `totalAppliedFilters` in every search response. A
name the api does not know is ignored in silence and leaves that count where it was, which is how
the table below separates the parameters that work from the ones that only look like they do.

## Search

`POST /api/3.5/it/search?adIds=&searchType=...`, form body:

| Parameter                      | Notes                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation`                    | `sale` or `rent`                                                                                                                                                           |
| `propertyType`                 | `homes`, `bedrooms`, `garages`, `offices`, `premises`, `buildings`, `storageRooms`, `vacationRentals`, `transfers`, `newDevelopments`, `luxury`. There is no type for land |
| `locationIds`                  | `[id]`, or `[id,id,id]` for several places at once                                                                                                                         |
| `shape`                        | a GeoJSON MultiPolygon, longitude before latitude, with `searchType=drawn`                                                                                                 |
| `order` / `sort`               | `publicationDate` and `desc` put the newest advert first                                                                                                                   |
| `numPage` / `maxItems`         | pages count from one; `maxItems` is capped at 50                                                                                                                           |
| `sinceDate`                    | `T`, `W` or `M` - today, this week, this month                                                                                                                             |
| `quality=high`, `gallery=true` | make the answer carry a description and a photo                                                                                                                            |

`searchType` accepts `aroundMe`, `live`, `drawn`, `locationIds`, `phone`, `freeText` and `zoiId`.

An advert carries `propertyCode`, `price`, `size`, `rooms`, `bathrooms`, `address`, `latitude`,
`longitude`, `description`, `thumbnail`, `url` and its own `locationId`. A figure the advert does
not state arrives as `0`, not as an absent field.

`address` is the line the website prints on a card - "Bilocale in Via Tito Vignoli s.n.c,
Lorenteggio, Milano" - so an advert read through the api and the same advert scraped off a page
describe themselves in the same words.

`?adIds=<propertyCode>` answers with that one advert, but only when `operation` and `propertyType`
match it as well, so an advert cannot be looked up by its code alone.

## The website's filters, and the api's

The website hides every filter in one path segment, `con-prezzo_450000,ascensori`. The vocabulary
was read off a rendered search page, where each filter is a link, and each mapping was then
confirmed against the api. `lib/services/idealista/search-filters.js` holds the table.

Two of the website's names are traps. `con-prezzo_N` is the **maximum** price, not the minimum -
its links sit in the dropdown whose placeholder is "Max" - while `con-dimensione_N` is the
**minimum** size and `con-dimensione-max_N` the maximum. The minimum price is `con-prezzo-min_N`.

`bedrooms` counts what the website calls "locali", the same figure the advert reports as `rooms`:
`con-bilocali-2` is `bedrooms=2`, and an advert answering it reports `rooms: 2`. The top value of
`bedrooms` and of `bathrooms` means "or more", as the website's own labels say.

Filters with no counterpart in the api, which is why the url carrying one is read off the website
instead:

- `terrazza`, `terrazza-e-balcone`. Only `balcony` exists; `terrace` is ignored.
- `giardino-privato`. `garden` covers a shared garden as well, so it is the wider search.
- `appartamenti`. It stands for flats, penthouses and duplexes together, and the api honours one
  property shape per search - `flat=1&penthouse=1` answers exactly what `flat=1` answers.
- the energy classes and the letting terms.

`preservation` takes one of `good`, `renew` and `newdevelopment`. It refuses a list and answers a
second value with a 500, while the website lets several be ticked and means their union. A url
naming two is therefore run twice and the answers are merged. The two sets overlap - an advert can
be both - so the merge has to be by `propertyCode` rather than by adding the totals up.

`subTypology` names the shape of a house: `independantHouse`, `semidetachedHouse`, `terracedHouse`,
`villa` and a long tail of regional ones. It is only read when `chalet` is **not** sent; with
`chalet=1` in the same body it is ignored and the search widens to every house.

## Locations

`POST /api/3.5/it/search/locations` answers with the ancestors of the location it is asked about
and its children, under the keys `provinces`, `municipalities`, `districts` and `neighborhoods`. It
needs one of `locationIds`, `center`, `shape`, `freeText` and a few others, so the list of provinces
is read by opening some location and taking the `provinces` it comes with. A province with no
advert of the kind asked for is left out of the answer.

An italian location id reads `0-EU-IT-<province>-<zone>-<group>-<municipality>-<district>-
<neighborhood>`. A name is qualified with the place above it - `Abbiategrasso, Milano` - and the
url spells it without that qualifier at every level below the municipality, so both spellings are
matched.

The **zone** - `0-EU-IT-BS-02`, "Sebino-Franciacorta" - is a real location that can be searched, and
the catalogue does not list it: it goes from a province straight to its municipalities. A zone id is
the five-segment prefix of any municipality id, and a search for it answers with its name in
`searchTitle`.

A zone has no url of its own. `https://www.idealista.it/vendita-case/sebino-franciacorta-brescia/`
is a 404.

## Areas, and the codes that name them

A search over several areas at once is a `/multi/` url, and it names each area in a code of three
characters: `/multi/vendita-case/a5W,a7j,aR0,dJY/`.

**There is no map from a code to a name.** The codes are row numbers in a table only idealista
holds. They are not in the api's catalogue, not in the markup of the page they address, and they
encode nothing - `dJo` and `dJr` are the province and the city of Brescia, `dJV` a quarter of it,
and neighbouring numbers are unrelated places elsewhere.

Two sources on the website hold the map, and neither can be harvested:

- `GET /{lang}/multizoneSearcherLocationsSuggestion?searchField=<text>&operation=1&typology=1`,
  which the area picker calls. It answers `{name, count, category, shortUri, parentName}` per
  match, where `shortUri` is the code and `category` is `Provincia`, `Area`, `Comune` or
  `Quartiere`. It matches on text, answers at most ten, and is behind DataDome.
- any rendered search page, which carries its own codes already resolved, as
  `"geo":{"type":"multiZone","locationId":[...]}`.

`https://mt1.idealista.it/19/tree/all-it-tree.json` lists every code - 110 provinces and 14190
nodes - as a tree of `{id, children}`. It carries no names, and its children are ordered by
idealista's internal id rather than by name, so it says which codes exist and not what they are.

### How a code is resolved anyway

Without asking the website, and exactly:

1. `GET https://mt1.idealista.it/19/paths/it/{code}` answers with the border of the area, as encoded
   polylines - the format google maps draws with - grouped by parentheses, `((ring)(ring))`.
2. Search that border as a `shape`. Every advert inside it carries the `locationId` of the location
   it belongs to, and the id all of them share is the location the code stands for.
3. Confirm it: the total for that location and the total for the border have to agree.

The confirmation is what makes the third step safe, because a sample can sit in one corner of a
large area. The border alone is a slightly different search - it catches a few neighbours whose
coordinates fall on the wrong side of a line, and it misses adverts the portal placed by address
rather than by point - so it is used only where a code cannot be named at all.

`lib/services/idealista/zones.js` does this, and caches it: a border does not move.

## Numbers to check a change against

A search whose url is
`/multi/vendita-case/a5W,a7j,aR0,dJY/con-prezzo_450000,prezzo-min_180000,dimensione_80,dimensione-max_250,case-indipendenti,villette-bifamiliari,villette-a-schiera,ville-indipendenti,trilocali-3,quadrilocali-4,5-locali-o-piu,nuova-costruzione,buono-stato/`
covers Sebino Bergamasco, Val Calepio, Ospitaletto and Sebino-Franciacorta, and the website reports
328 adverts for it.

The api answers 268 for `preservation=good` and 75 for `preservation=newdevelopment`, which share 15
adverts: 328 distinct. The same search asked by border rather than by location answers 273 and 75,
which is the measure of what a border costs.
