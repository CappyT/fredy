# Reverse Engineered the Italian Coverage Checker

Italy has no public broadband register like Germany's Breitbandatlas or Switzerland's Bakom layers.
What it has is the coverage checker behind `copertura.navigabene.it`, which the internet service
reseller Navigabene runs for its own customers - and whose backend answers to a plain GET, without
a key, a session or a challenge. This file records what was measured about it, because Fredy's
connectivity feature asks it for the italian listings.

The client is `lib/services/connectivity/client/navigabeneClient.js`, registered as the
connectivity source `it-navigabene` for `it`.

## Hosts

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

## The lookup

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

## The verdict

```json
{"error": false, "results": [{"technology": "EVDSL", "carrier": "TIM", "download_speed": 102,
  "upload_speed": 20, "monthly_price": 28.95, "name": "FTTC 200 EASY", ...}]}
```

The results are **commercial offers**, not register cells: the checker answers what one operator
sells at one building today. What the answer means for a listing is read as the fastest offer per
technology, and the technologies it names are `FTTHNB` and `FTTH` (both fibre, the builder's and
the retailer's offer), `EVDSL` and `VDSL` (both copper to the cabinet), and `FWA` (the wireless
answer where nothing is buried). An empty `results` is a verdict too - the address is unserved -
and is stored as such, where a failed request is not stored at all and the client stands down for
a quarter of an hour.

Measured against listings Fredy holds (September 2026): a villa in Chiuduno answered EVDSL at
102 Mbit/s, attics in Bolgare EVDSL at 34 Mbit/s, and a house in Ranzanico an empty result - which
is exactly the spread the feature exists to show.

## What this does not cover

Mobile coverage. The checker answers fixed line only, and Italy's crowd-sourced mobile maps
(lteitaly.it among them) are a client of their own. The `mobile` half of a connectivity answer
stays null for italian listings, and the card renders the fixed line alone.
