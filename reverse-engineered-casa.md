# Reverse Engineered Casa.it

Casa.it is one of the three national portals Italian agencies publish to. Its website sits behind
DataDome; the api its android app talks to does not. This file records what was measured about that
api, and about the website's own url grammar, which is what a Fredy job holds.

The provider is `lib/provider/casa.js`. The translation from a website search url into a search the
api answers is in `lib/services/casa/`.

## Hosts

| Host                   | Serves                                                                         | Protected |
| ---------------------- | ------------------------------------------------------------------------------ | --------- |
| `esapi.casa.it`        | the search: `POST /listings/v2/search`, and `/listings/v2/search_map` for pins | no        |
| `smartsuggest.casa.it` | place lookup by name                                                           | no        |
| `api-lh.casa.it`       | the location hierarchy: zones of a town, reverse geocoding                     | no        |
| `images-1.casa.it`     | the photos                                                                     | no        |
| `www.casa.it`          | the website                                                                    | DataDome  |

The static assets under `www.casa.it/portal-srp/` are reachable without clearing the wall, which is
where the filter table below comes from.

## The search

```
POST https://esapi.casa.it/listings/v2/search
content-type: application/json
```

No key, no token, no signature, no cookie. `content-type` is the only header it needs.

```json
{"site": "it_casa", "page": 1, "size": 50, "sort": ["date-desc"],
 "query": [{"where": [...], "filters": {...}, "modifiers": {}}]}
```

`size: 0` answers with the total and no adverts, which is what makes a count cheap. The app asks for
20 and the website for 50. `data.total` is the count; the adverts are in `data.tiers[]`, under the
entry whose `tier` is `listings`.

`sort` takes `date-desc` - the api reads it as `inserted|desc` - and puts the newest advert first.
The rendered page offers no such order, which is the main reason to prefer the api.

### It never says no

This api does not refuse what it does not understand, and that shapes the whole design:

- An unknown filter name is dropped in silence. The search then runs without it.
- An unknown `property_type_group` answers with the residential one rather than with an error.
- An unknown `sort` token answers in the api's own order.
- A filter sent as a list where one value is wanted - or the other way round - answers with a bare
  21-byte "Internal Server Error", with no JSON and no message.

So the provider translates only what is in its table and renders the page for anything else. The
sibling provider for immobiliare.it does the opposite and lets the endpoint judge its own
parameters, because that one refuses what it dislikes and names the field. This one cannot be
trusted that way.

A handled failure does answer usefully: a 500 carrying the raw python exception and the body it was
sent. That is worth reading when something breaks.

## Where to search

Three forms, all confirmed:

| Form         | Written as                                          |
| ------------ | --------------------------------------------------- |
| a place      | `{"hkey": "a0d22860", "level": 9}`                  |
| a drawn area | `{"geo": {"polygon": [[lon, lat], ...]}}`           |
| a circle     | `{"geo": {"center": [lat, lon], "distance": 6970}}` |

`where` is a list and it means **or**: Roma 27891 plus Erbusco 153 answers 28044 for the two
together, so a url naming several places translates.

**The polygon is [lon, lat], the opposite of the url.** A search url writes its ring as
`geopolygon={"polygon":[[lat,lon],...]}`. Sent in that order the api answers 0 - it applies the
shape and matches nothing - which reads exactly like a search with no results. The centre of a
circle, confusingly, is [lat, lon].

`{"polygon": ...}`, `{"geo_shape": ...}` and `{"geo": {"geo_shape": ...}}` are all ignored in
silence and answer with the whole country.

The website's own pages use a fourth form, `{"seo": {"l9": {"adm": "roma"}}}`, which resolves a slug
at a named level without a lookup. It is not used here because the lookup answers the level as well,
and the level is the part a url does not state.

### The place lookup

`GET https://smartsuggest.casa.it/smartsuggest/v1/suggest/?query=<words>&site=it_casa`

The results are under `data.results`, and each carries `{id, hkey, level, name, slugs, type}`.
`slugs` is a string despite its name. Levels: 2 country, 4 region, 6 province, 9 town, 10 zone,
11 subzone.

**`hkey` is required and `id` is not accepted.** Sent as `{"id": "IT-LAZ-058091", "level": 9}` the
search answers 942851 - the whole country - with a first result from Abruzzo. The id is ignored,
not refused.

A name matches several levels: Roma is a province and the town in it. The url's grammar says which
is meant, so the level is chosen rather than ranked.

## Reading a url

The website writes a search in two shapes.

A **town search** says everything in its path: `/affitto/residenziale/roma/` is the contract, the
category and the place. `residenziale` becomes `property_type_group: "case"` - confirmed against the
page's own request, which the store carries as `apireq`, and against its total of 3701.

A **drawn search** says everything in its query string, at `/srp/map/`.

### The filters

Casa.it ships the converter that writes these urls, in `/portal-srp/common-*.js`. The table in
`lib/services/casa/search-filters.js` is that mapping read backwards:

| url                                   | api                                       |
| ------------------------------------- | ----------------------------------------- |
| `tr`                                  | `transaction.type`                        |
| `propertyTypeGroup`                   | `property_type_group`                     |
| `propertyTypes`                       | `property.types`                          |
| `priceMin` / `priceMax`               | `price.gte` / `price.lte`                 |
| `mqMin` / `mqMax`                     | `surface.gte` / `surface.lte`             |
| `numRoomsMin` / `numRoomsMax`         | `rooms.gte` / `rooms.lte`                 |
| `mqpriceMin` / `mqpriceMax`           | `mqprice.gte` / `mqprice.lte`             |
| `paymentMin` / `paymentMax`           | `payment.gte` / `payment.lte`             |
| `buildingYearMin` / `buildingYearMax` | `building_year.gte` / `building_year.lte` |
| `numParkingSpaces`                    | `carparks.gte`                            |
| `buildingCondition`                   | `building_condition`                      |
| `garden`                              | `garden.type`                             |
| `heatingType`                         | `heating.types`                           |
| `energyClass`                         | `energy_class`, one value only            |
| `publicationDt`                       | `publication_date`, one value only        |
| `sellerType`                          | `publisher`                               |
| `photo`                               | `only_with_photos`                        |
| `pId`                                 | `publisher.id`                            |
| `rentType`                            | `rent_type`                               |

### The encoding trap

The website encodes a value with an encoder of its own, in the same bundle: accents stripped, an
apostrophe turned into a space, a **space turned into `+`**, a comma into `%2C`. Whatever comes out
of that is fed to the api verbatim.

So a value must be taken from the url **undecoded**. A list is split on `%2C`, and the `+` inside an
item stays where it is:

```
propertyTypes=casa+indipendente%2Cvilla%2Cvilletta+a+schiera
-> "property.types": ["casa+indipendente", "villa", "villetta+a+schiera"]
```

Decoding it the ordinary way gives `"casa indipendente"`, which matches nothing, and the api says
nothing about it. On one measured search the correct form answers 144 and the decoded form answers
61 - the 61 being the villas, the only item whose name has no space in it.

## An advert

| Field       | Path                                                  |
| ----------- | ----------------------------------------------------- |
| id          | `listing_id`                                          |
| title       | `title.it`                                            |
| price       | `transaction.price.value`                             |
| surface     | `property.characteristic.property_surface`            |
| rooms       | `property.characteristic.rooms_count`                 |
| address     | `property.geo.street`, `.district_name`, `.city`      |
| coordinates | `property.geo.lat`, `.lon`                            |
| photo       | `media.items[].uri`, under `https://images-1.casa.it` |

The listing's page is `https://www.casa.it/immobili/<listing_id>/`, which is the form the website's
own store uses. The api also offers `meta.links.pretty.href`, which is not needed.

There is no publication date on the advert. `modified` is the last edit. The api sorts by insertion
date all the same, and `listing_id` increases over time.

## Numbers to check a change against

- `/affitto/residenziale/roma/` - 3701, the figure the page itself reports.
- The drawn search over Franciacorta for `casa+indipendente,villa,villetta+a+schiera` between
  200000 and 450000, at least 80 m2, at least 3 rooms, `abitabile` - **144**. Without the property
  types it is 359, which is what the encoding trap costs if the values are decoded.
- Roma level 9 (`hkey a0d22860`): 37285 all contracts, 27891 sale, 9395 rent.
