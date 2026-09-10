# Reverse Engineered the Italian Coverage Checkers

Italy has no public broadband register like Germany's Breitbandatlas or Switzerland's Bakom layers.
What it has is private checkers, run by people who want to sell a connection, and this file records
what was measured about the two Fredy can ask. Both answer a plain GET without a key, a session or
a challenge; neither publishes terms or an api, which is why both clients stand down after a
failure and both sources are switchable in the settings like every other register.

| Source          | Client                       | Answers with                                    |
| --------------- | ---------------------------- | ----------------------------------------------- |
| `it-navigabene` | `client/navigabeneClient.js` | one reseller's retail catalogue, per building   |
| `it-fibermap`   | `client/fibermapClient.js`   | the wholesale networks themselves, per building |

They are **alternatives, not a pair**. Merging a shop's price list with a wholesale network map
produces no verdict anybody can act on, so `sourceForCountries` asks the first source for the
country that the operator has left switched on. Navigabene is declared first, which keeps an
installation that upgrades into this release answering exactly the way it did before; an operator
who prefers fibermap unticks Navigabene on the connectivity settings page and the other one takes
over. There is no new kind of setting for this - it is the same per-source switch that turns a
register off entirely.

## The stand-off, and what counts as one

Both clients keep the same rule, and it is worth stating once rather than twice, because getting it
wrong is expensive in a way that is not obvious from a single request.

A sweep asks one of these checkers for up to a couple of hundred listings in a run, and it writes
down what it gets. An address the checker genuinely has no answer for is stamped - "no coverage
data", for six months - so that the same dead address is not asked again on every sweep from here
on. That is the right treatment for one bad address and the catastrophic one for a service that has
stopped talking to us: a checker answering the same refusal to everything would, read as a verdict,
write "unserved" across the entire italian backlog and then keep it there for half a year.

So each answer is read as one of two things:

| Answer                                         | Read as                     | Effect                                     |
| ---------------------------------------------- | --------------------------- | ------------------------------------------ |
| `400`, `404`, `410`, `422`                     | a verdict about the address | miss, listing stamped, sweep carries on    |
| a `2xx` whose body will not parse as JSON      | a wasted request            | miss, listing stamped, sweep carries on    |
| `401`, `403`, `407`, `451`, `429`, any `5xx`   | the service refusing us     | source stands down, listing left unstamped |
| nothing at all - reset, timeout, dns           | the service refusing us     | source stands down, listing left unstamped |
| fibermap's `{"status":"blocked"}` with a `200` | the quota (see below)       | source stands down, listing left unstamped |

The two halves of the middle group are the ones worth explaining.

**401 and 403.** Neither checker has a key or a session, so there is nothing an individual request
can do to earn a 401 - which makes it a front door shut against this installation, not a statement
about a door number. 403 is the same and rather likelier: fibermap is a WordPress install, and the
thing most often sitting in front of one is a security plugin or a CDN that decides a scripted user
agent is unwelcome and answers 403 to everything for the next hour. 407 (a proxy in front of _this_
installation) and 451 (the service withdrawn for legal reasons) round the list out.

**A 200 that is not JSON.** Read the other way: `admin-ajax.php` answers a bare `0` when its handler
declines, and a WordPress install will happily emit a PHP warning or a fragment of markup ahead of
its payload. An api host behind a frontend can answer an error page or a cache's holding page the
same way. The service is plainly answering, so the body is fetched inside the transport's `try` and
parsed outside it - a `JSON.parse` that throws is one wasted request and nothing more. Putting the
parse inside the catch that stands the source down would be self-inflicted, and permanently so: a
paused source leaves the listing unstamped, the sweeper takes unstamped listings first, and that one
bad reply would come back around to pause the source again on every sweep, with every older listing
behind it never reached.

## Navigabene

The coverage checker behind `copertura.navigabene.it`, which the internet service reseller
Navigabene runs for its own customers.

### Hosts

| Host                                      | Serves                                                             | Protected               |
| ----------------------------------------- | ------------------------------------------------------------------ | ----------------------- |
| `prod01.copertura.contratti.net`          | the coverage api                                                   | no                      |
| `copertura.navigabene.it`                 | the checker's web frontend                                         | Cloudflare (unverified) |
| `www.casa.it/portal-srp/api/v1/deeplink/` | an app-link resolver of the casa.it app, which shares the platform | no                      |

The checker's frontend is a small jQuery app whose script carries everything this file records:
`prod01.copertura.contratti.net` as the api host, and Navigabene's operator id
`b01fdb33-0011-4158-8f90-3702c74d5fae` in every verdict request. `contratti.net` is the B2B
platform the reseller's contracts run on; there is no published api and no published terms, which
is why the client stands down after a failure and the source is switchable in the settings like
every other register.

### The lookup

An address is asked in four steps, all GET, all answered in milliseconds:

| Path                                                       | Answers                                          |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `/copertura/city/{name}`                                   | `{istat_code, province, name}` per match         |
| `/copertura/street/{istat}/{name}`                         | `{particella, strada, civico, egon}` per match   |
| `/copertura/street/{istat}/{particella}/{strada}/{civico}` | the street's civic numbers, each with its `egon` |
| `/copertura/get/{operatoreId}/{egon}/{istat}/{base64}`     | the offers for one building                      |

`egon` is the building id the checker's own database counts addresses by. The street search
matches the whole of what it is given - "Via Torino" finds `TORINO` - so the particella rides
along; the civic step wants the street's own `particella` and `strada`.

The verdict request's last part is the base64 of the JSON the checker itself would assemble, and
it is the answer's address line, not an input: `{"particella", "civico", "strada", "codice_istat",
"comune"}`. The civic number in it is the one whose `egon` travels in the path.

An address without a civic number - the portals print "s.n.c", senza numero civico, for those - is
answered for the street's first building, which is what the street search returns anyway. Fredy
marks nothing in the UI for this, because the checker cannot be asked anything narrower than a
building, and a building it must be given.

### The verdict

```json
{"error": false, "results": [{"technology": "EVDSL", "carrier": "TIM", "download_speed": 102,
  "upload_speed": 20, "monthly_price": 28.95, "name": "FTTC 200 EASY", ...}]}
```

The results are **commercial offers**, not register cells: the checker answers what one operator
sells at one building today. What the answer means for a listing is read as the fastest offer per
technology, and the technologies it names are `FTTHNB` and `FTTH` (both fibre, the builder's and
the retailer's offer), `EVDSL` and `VDSL` (both copper to the cabinet), and `FWA` (the wireless
answer where nothing is buried). An empty `results` is a verdict too - the address is unserved -
and is stored as such, where a request the service refused is not stored at all and stands the
client down for a quarter of an hour. Which refusals those are is the table above.

Measured against listings Fredy holds (September 2026): a villa in Chiuduno answered EVDSL at
102 Mbit/s, attics in Bolgare EVDSL at 34 Mbit/s, and a house in Ranzanico an empty result - which
is exactly the spread the feature exists to show.

## Fibermap

`fibermap.it` is a WordPress site that sells business connectivity and, to qualify its leads, runs
a coverage form over what looks like a wholesale aggregator's feed. Where Navigabene names offers,
fibermap names **networks**: FiberCop, Open Fiber, Fastweb, EOLO, OpNet, Retelit - each with the
technology it reaches the building on, the speed it reaches it at, the exchange or cabinet it
comes from, and a per-network sellability code.

The client is `lib/services/connectivity/client/fibermapClient.js`, registered as `it-fibermap`
for `it`.

### The endpoint

One URL for everything, which is what a WordPress plugin's ajax handler is:

```
GET https://fibermap.it/wp-admin/admin-ajax.php
      ?action=fbc_ajax_call&act=resolveAddress
      &input=<query|streetId|buildingId>&type=<default|street|building>
      &label=<what the previous step printed>&tipoCliente=<privato|business>
```

No key, no session, no cookie, no CSRF nonce, no challenge - a bare `curl` with a browser's
`User-Agent` is answered. `label` is echo, not input: a wrong one changes nothing. `tipoCliente`
changes nothing either in the answers measured - both halves come back whichever is asked for -
but the site's own form refuses to search without it, so `privato` is sent.

Everything answers **HTTP 200**, refusals included. The envelope is what has to be read:

```json
{ "status": "ok", "type": "building", "data": { "380100175085143": "Via Al Poggio 1/X, Ranzanico" } }
```

`type` says what came back, and it is the _answer's_ type rather than the request's:

| Sent `type` | `input`                        | Answered `type` | `data`                                 |
| ----------- | ------------------------------ | --------------- | -------------------------------------- |
| `default`   | "Via Al Poggio 1/X, Ranzanico" | `building`      | `{buildingId: "<street> <n>, <town>"}` |
| `default`   | "Via Garibaldi, Brescia"       | `street`        | `{streetId: "<street>, <town>"}`       |
| `street`    | a street id                    | `building`      | `{buildingId: "<street>, <town> <n>"}` |
| `building`  | a building id                  | `coverage`      | the verdict                            |

The two building labels are worth reading twice: the address search prints the door number behind
the street, the street's own list prints it behind the _town_. `parseLabel` in
`lib/services/connectivity/italianAddress.js` looks for it on both ends.

`data` is an id-to-label object, or an empty **array** when there is nothing - `[]`, not `{}`.

### The search is fuzzy, and that is the dangerous part

Asked for "Via Roma 1, Milano" - a street Milano does not have - it does not answer empty. It
answers with Via Giulio Romano 1, Viale Romagna 1, Via Antonio Romano' 1 and Via Quinto Romano 13.
Taking the first suggestion would report a stranger's fibre as this flat's, so the client accepts a
suggestion only when its street and its town are the ones that were asked for and, where the
address named a door number, when that number matches too. Accents and punctuation are normalised
away; a different particella is not - Brescia has a Corso _and_ a Piazzale Garibaldi and they are
two places, so "Via Garibaldi 10, Brescia" matching neither is the correct answer.

The suggestion list is also capped at ten, so a busy street name can push the right door out of it.
That is what the street route is for: resolve the street, exchange its id for its own list of door
numbers, which comes back complete. The client remembers every door on that list, so the second
listing on the same street costs one request rather than three.

### The verdict

```json
{
  "geo": {
    "unique_address_id": "380130068720101",
    "codice_istat": "1272",
    "city": "TORINO",
    "civico": "12/A",
    "lat": "45.0828572",
    "long": "7.642424800000001"
  },
  "network": {
    "shared": {
      "FTTC_FC": {
        "stato": 1,
        "speed_dl": 200,
        "speed_ul": 20,
        "distanza": 90,
        "centrale": "TORIITBT",
        "cabinet": "01104U_068",
        "copertura": "FiberCop NGA FTTC",
        "vendibile": "Attivo"
      },
      "FTTH_FC": {
        "stato": 1,
        "speed_dl": 2500,
        "speed_ul": 1000,
        "copertura": "FiberCop NGA FTTH",
        "vendibile": "Attivo"
      },
      "FWA_4G_OPNET": { "stato": 1, "speed_dl": 100, "copertura": "OpNet FWA 4G", "vendibile": "Coperto" }
    },
    "dedicated": {
      "GEA_FC": { "stato": 1, "speed_dl": 1000, "copertura": "FiberCop Terminating Ethernet (GEA)", "vendibile": "A" }
    }
  }
}
```

The key is technology and network in one: `FTTH_FC` FiberCop's fibre, `FTTH_OF_AB` Open Fiber's in
the areas it built commercially, `FWA_EOLO` and `FWA_4G_OPNET` the two wireless carriers,
`ADSL_FC` copper straight from the exchange. The technology is the part in front of the first
underscore, which is why `normalizeFibermap` reads a prefix rather than a closed list of keys - the
list of networks is somebody's CMS content and will grow.

Codes seen in the wild: `ADSL_FC`, `FTTC_FC`, `FTTH_FC`, `FTTH_OF_AB`, `FWA_EOLO`, `FWA_4G_OPNET`
shared; `GEA_FC`, `FTTO_FC`, `BEA_OF`, `P2P_FW`, `RETELIT` dedicated.

**Only the `shared` half is read.** `dedicated` is business access - Fibra Dedicata, GEA, FTTO, BEA

- a symmetric line quoted per site and built to order, and it answers 1000 Mbit/s at almost every
  address in a town. Counting it would tell somebody reading about a flat that they can have a
  gigabit when what they can have is a quotation.

**`stato` and `vendibile` together decide availability.** Every technology carries its own
sellability vocabulary, and the site ships the whole mapping to the browser inside its results
page: FiberCop's fibre is `Attivo` / `Pianificato` / `Sospeso` / `Saturo` / `NO`, a wireless
carrier's is just `Coperto`, a dedicated line's is a class letter. Read back to two states, the
codes that mean "not here" are `NO` and `Pianificato`. `Saturo` and `Sospeso` stay in: the network
is at the door and whether a port is free today is between the buyer and the operator, not a
property of the flat.

`ADSL` counts towards the headline speed but gets no technology chip of its own. That is the same
shape the German register has - one "all technologies" ladder for the headline, three named
technologies underneath - and it keeps three locale files from growing a chip for the least
interesting answer there is.

### The quota, which is the reason this source is paced the way it is

**Five coverage lookups per IP address, measured.** The sixth answers:

```json
{ "status": "blocked", "type": "coverage" }
```

with a 200. The address search kept working throughout - only the `type=building` step is counted.
The block was still in place thirteen minutes later, which is where measuring stopped; the upper
bound of the window is unknown. The client treats `blocked` exactly like a 429: the source stands
down, and for an hour rather than the quarter of an hour the other clients use, because a quota is
not an outage and asking again sooner only spends the next one. It is also why the client resolves an address in as few requests
as it can and remembers a whole street from the one answer that lists it.

Note the shape of it, because it is the one case where a 200 body does stand the source down: this
is the plugin saying "not you, not now", where a `0` or a stray PHP warning is the plugin saying
"not this question". The first is read off `status`; the second is a parse that fails and costs one
request. Neither is a verdict about the flat.

A sweep will therefore work an italian backlog down in small bites, which is exactly what the
per-run ceiling in the settings is for. It is not a source that will fill in a thousand listings
overnight.

### Measured, September 2026

| Address                      | Verdict                                                 |
| ---------------------------- | ------------------------------------------------------- |
| Via Giulio Romano 1, Milano  | FTTH 2500 (FiberCop **and** Open Fiber), ADSL 20        |
| Via Romagnano 12/A, Torino   | FTTH 2500, FTTC 200, FWA 100 (OpNet), ADSL 20 saturated |
| Via Al Poggio 1/X, Ranzanico | FTTC 200, FWA 300 (EOLO), no fibre (`stato: 0`)         |

Response times were 1.2 s to 3 s. Six concurrent address searches were all answered.

## What neither of them covers

Mobile coverage. Both answer fixed line only, and Italy's crowd-sourced mobile maps (lteitaly.it
among them) are a client of their own. The `mobile` half of a connectivity answer stays null for
italian listings, and the card renders the fixed line alone.

Upload speed. Both sources report it - fibermap as `speed_ul` per network - and Fredy's
`Connectivity` shape has nowhere to put it, so it is dropped. Adding it would mean a field on every
source's answer and a row on the card in three languages, which is a decision for whoever wants
it rather than a side effect of adding a source.
