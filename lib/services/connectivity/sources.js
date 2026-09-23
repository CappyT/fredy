/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { fetchGermanConnectivity, isBreitbandatlasPaused } from './client/breitbandatlasClient.js';
import { fetchSwissConnectivity, isGeoAdminPaused } from './client/geoAdminClient.js';
import { fetchItalianConnectivity, isNavigabenePaused } from './client/navigabeneClient.js';
import { fetchItalianFibermapConnectivity, isFibermapPaused } from './client/fibermapClient.js';
import { fetchAustrianConnectivity, isBreitbandatlasAtPaused } from './client/breitbandatlasAtClient.js';
import { fetchSpanishConnectivity, isCoberturaEsPaused } from './client/coberturaEsClient.js';

/**
 * Which register answers for which country.
 *
 * There is no pan-European source for this: every country runs its own register, on its own
 * terms, in its own units. So each one is a client of its own behind a common shape, and a country
 * nobody has written a client for simply has no answer - which is a state the UI has to render
 * anyway, because a register can also be down or switched off.
 *
 * A country can have more than one entry. Italy publishes no register at all, so what answers for
 * it are two private checkers that disagree about what "available" means, and which of them a
 * given installation trusts is the operator's call rather than ours. `sourceForCountries` is where
 * that call is read.
 *
 * @typedef {Object} ConnectivitySource
 * @property {string} id Stable id, stored on the listing and used as the settings key.
 * @property {string[]} countries ISO 3166-1 alpha-2 codes this source covers.
 * @property {(lat: number, lng: number, address?: string) => Promise<import('./normalize.js').Connectivity|null>} fetch
 *   The German and Swiss registers answer by point; the Italian one has no way to be asked by
 *   point and reads the listing's address instead, which the contract carries for it.
 * @property {'point'|'address'} [keyedBy] What the source's answer actually depends on, which is
 *   what its cached answers may be shared between. Absent means the point, as it does for a
 *   register that is asked by coordinate. A source that answers by address has to say so: two
 *   listings ten metres apart are two different doors to it, and one of them would otherwise be
 *   served the other's verdict - or the null a neighbour's unreadable address produced.
 * @property {() => boolean} isPaused Whether the client is standing off after a failure.
 */

/** @type {ConnectivitySource[]} */
export const SOURCES = [
  {
    id: 'de-bba',
    countries: ['de'],
    fetch: fetchGermanConnectivity,
    isPaused: isBreitbandatlasPaused,
  },
  {
    id: 'ch-bakom',
    countries: ['ch'],
    fetch: fetchSwissConnectivity,
    isPaused: isGeoAdminPaused,
  },
  {
    id: 'it-navigabene',
    countries: ['it'],
    fetch: fetchItalianConnectivity,
    keyedBy: 'address',
    isPaused: isNavigabenePaused,
  },
  {
    id: 'it-fibermap',
    countries: ['it'],
    fetch: fetchItalianFibermapConnectivity,
    keyedBy: 'address',
    isPaused: isFibermapPaused,
  },
  {
    id: 'at-rtr',
    countries: ['at'],
    fetch: fetchAustrianConnectivity,
    isPaused: isBreitbandatlasAtPaused,
  },
  {
    id: 'es-setid',
    countries: ['es'],
    fetch: fetchSpanishConnectivity,
    isPaused: isCoberturaEsPaused,
  },
];

/** @type {string[]} */
export const SOURCE_IDS = SOURCES.map((source) => source.id);

/**
 * Every source that covers a set of countries, in the order they are declared.
 *
 * A listing is geocoded against the countries its portal serves, which is usually one. Where it is
 * several, a source covering any of them is a candidate - two registers cannot be merged into one
 * verdict, and picking one beats inventing a combination.
 *
 * @param {string[]} countries
 * @returns {ConnectivitySource[]}
 */
export function sourcesForCountries(countries) {
  if (!Array.isArray(countries) || countries.length === 0) {
    return [];
  }
  const wanted = countries.map((code) => String(code).toLowerCase());
  return SOURCES.filter((source) => source.countries.some((code) => wanted.includes(code)));
}

/**
 * The source that answers for a set of countries.
 *
 * Italy has two, and that is what this second argument is for. They are alternatives rather than a
 * pair - Navigabene reads one reseller's catalogue, fibermap the wholesale networks, and no
 * sensible verdict comes out of merging them - so the first one the operator has left switched on
 * answers and the other is never asked. An operator who wants fibermap unticks Navigabene, which
 * is the same switch that turns a register off entirely and needed no new kind of setting.
 *
 * Declaration order is therefore what decides the default, and Navigabene stays first: an
 * installation that upgrades into this release must keep answering the way it did yesterday.
 *
 * @param {string[]} countries
 * @param {(sourceId: string) => boolean} [isEnabled] Whether the operator has that source switched
 *   on. Absent means every source counts, which is what a caller asking "is this country covered
 *   at all" wants.
 * @returns {ConnectivitySource|null}
 */
export function sourceForCountries(countries, isEnabled) {
  const covering = sourcesForCountries(countries);
  const chosen = isEnabled == null ? covering[0] : covering.find((source) => isEnabled(source.id));
  return chosen ?? null;
}
