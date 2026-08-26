/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Turns the place a search url names into the ids the search endpoint filters by.
 *
 * A search url names its place in words - `/vendita-case/erbusco/` - while the endpoint wants
 * `idComune=7369`, and nothing in the url carries that number. The website knows it because its
 * page is rendered with the search already resolved, which is why reading a town search used to
 * mean opening a browser and clearing a bot wall.
 *
 * The android app resolves a place without any of that: it has a geography service of its own, on
 * a host that serves plain JSON to an unauthenticated request. It answers with the place and with
 * every place above it - quarter, town, province, region - and those are the same ids the website's
 * own endpoint filters by.
 *
 * See `reverse-engineered-immobiliare.md` for the levels this answers with and for why the url's
 * own grammar, rather than the service's ranking, says which one is meant.
 */

import logger from '../logger.js';

/** The host the android app talks to. Unrelated to www.immobiliare.it, and not behind DataDome. */
const BASE_URL = 'https://android-imm-v4.ws-app.com/b2c/v1';

/**
 * The app names itself in a structured user agent. The service answers a request without it, but a
 * client that looks like the app is the one it is meant to serve.
 */
const USER_AGENT =
  'WSCommand3<Furious>|REL|PRD|1080,2410,2.625|26.13.0|ANDROID|Google Pixel 10 Pro|17|PHO|2.0-01/09/2016-16:40|0|0';

/**
 * What each level of the answer is called, by the `type` the service tags it with, and the query
 * parameter the search endpoint filters that level by.
 *
 * A quarter is filtered as a list, which is how the website asks for several at once.
 */
const LEVELS = {
  '-1': { name: 'nation', param: 'idNazione' },
  0: { name: 'region', param: 'fkRegione' },
  1: { name: 'province', param: 'idProvincia' },
  2: { name: 'city', param: 'idComune' },
  3: { name: 'quarter', param: 'idMZona[]' },
};

/**
 * The suffix the website hangs on a province, to tell `/vendita-case/brescia-provincia/` - every
 * town in the province - from `/vendita-case/brescia/`, which is the city.
 */
const PROVINCE_SUFFIX = '-provincia';

/**
 * Places already resolved. A town keeps its id, so a job running every few minutes asks once.
 *
 * @type {Map<string, Promise<Record<string, string>|null>>}
 */
const places = new Map();

/**
 * The words a url spells a place with, as a name to look up.
 *
 * @param {string} slug
 * @returns {string}
 */
export function toQuery(slug) {
  return String(slug).replace(/-/g, ' ').trim();
}

/**
 * Whether a place the service returned is the one the url asked for.
 *
 * The service ranks by relevance and answers a town in another province as readily as the one meant,
 * so the name has to match rather than merely rank first.
 *
 * @param {any} place
 * @param {string} slug
 * @returns {boolean}
 */
function matches(place, slug) {
  const label = String(place?.label ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  // A label reads "Città Studi, Susa", qualifying the place with something the url leaves out.
  const head = label
    .split(',')[0]
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return head === slug;
}

/**
 * Look a place up by the name a url spells it with.
 *
 * @param {string} slug One path segment, for example `erbusco` or `citta-studi`.
 * @param {string} [within] The slug of the place above it, when the url names one, which is what
 *   tells two towns of the same name apart.
 * @returns {Promise<Record<string, string>|null>} the criteria naming that place and every place
 *   above it, or null when nothing matches
 */
async function lookUp(slug, within) {
  const province = slug.endsWith(PROVINCE_SUFFIX);
  const named = province ? slug.slice(0, -PROVINCE_SUFFIX.length) : slug;
  // The url's own grammar says which level is meant, and it has to, because a name alone does not:
  // "Brescia" is a province, a town in it, and a quarter of a town in Rimini.
  const wantedType = province ? 1 : within == null ? 2 : 3;
  const query = within == null ? toQuery(named) : `${toQuery(named)} ${toQuery(within)}`;
  const response = await fetch(`${BASE_URL}/geography/autocomplete?query=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'it-IT' },
  });
  if (!response.ok) {
    logger.warn(`Immobiliare.it: the geography service answered ${response.status} for "${query}".`);
    return null;
  }

  const found = await response.json();
  const place = Array.isArray(found)
    ? found.find((entry) => entry?.type === wantedType && matches(entry, named))
    : null;
  if (place == null) return null;

  /** @type {Record<string, string>} */
  const criteria = {};
  for (const entry of [...(place.parents ?? []), place]) {
    const level = LEVELS[String(entry?.type)];
    if (level != null && entry?.id != null) criteria[level.param] = String(entry.id);
  }
  return criteria;
}

/**
 * Resolve the place a search url names.
 *
 * @param {string[]} slugs The path segments naming the place, widest first.
 * @returns {Promise<Record<string, string>|null>} the criteria to search it by, or null when the
 *   place cannot be found
 */
export function resolvePlace(slugs) {
  if (slugs.length === 0) return Promise.resolve(null);

  // The last segment is the place; the one before it, where there is one, tells it from its
  // namesakes. Deeper nesting than that names the same place twice over.
  const slug = slugs[slugs.length - 1];
  const within = slugs.length > 1 ? slugs[slugs.length - 2] : undefined;
  const key = `${within ?? ''}/${slug}`;

  if (!places.has(key)) {
    places.set(
      key,
      lookUp(slug, within).catch((error) => {
        places.delete(key);
        throw error;
      }),
    );
  }
  return /** @type {Promise<Record<string, string>|null>} */ (places.get(key));
}

/**
 * Forget the places resolved so far. Exists for the tests, which serve their own.
 *
 * @returns {void}
 */
export function clearPlaceCache() {
  places.clear();
}
