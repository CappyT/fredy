/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * What a search url's words mean to the api.
 *
 * The website hides the whole search in its path - the category in the first segment, every filter
 * in a `con-...` segment near the end - so this table is what lets a pasted url be asked of the api
 * instead of being rendered. Each entry was read off a search page and confirmed against the api,
 * which answers with the number of filters it accepted and so says plainly when a name is wrong.
 *
 * A word that is missing here is not translated to something close: the caller reads the website
 * for that search instead. A filter quietly dropped would widen the search behind the user's back,
 * and they would be told about adverts they asked not to see.
 *
 * Deliberately absent, because the api offers nothing that means the same thing:
 * - `terrazza`, `terrazza-e-balcone` - only a balcony has a parameter
 * - `giardino-privato` - `garden` covers a shared garden as well, so it is the wider search
 * - `appartamenti` - stands for flats, penthouses and duplexes together, and the api honours only
 *   one property shape per search
 * - `ville`, `rustici`, `mansarde`, `loft-open-space` - the api has a shape for each of these and
 *   which one is guesswork, where the four house shapes below were confirmed against a live search
 * - the energy classes and the letting terms
 *
 * `reverse-engineered-idealista.md` records the two names that read backwards - `con-prezzo_N` is a
 * maximum where `con-dimensione_N` is a minimum - and how each mapping was confirmed.
 */

/** Website category to the api's `propertyType`. `terreni` is absent: the api sells no land. */
const CATEGORIES = {
  case: 'homes',
  stanze: 'bedrooms',
  uffici: 'offices',
  negozi: 'premises',
  garage: 'garages',
  edifici: 'buildings',
  cantine: 'storageRooms',
};

/** Website operation to the api's `operation`. */
const OPERATIONS = { vendita: 'sale', affitto: 'rent' };

/** Filters carrying a number, which the website writes as `<name>_<number>`. */
const NUMBERED = [
  { pattern: /^prezzo_(\d+)$/, name: 'maxPrice' },
  { pattern: /^prezzo-min_(\d+)$/, name: 'minPrice' },
  { pattern: /^dimensione_(\d+)$/, name: 'minSize' },
  { pattern: /^dimensione-max_(\d+)$/, name: 'maxSize' },
];

/**
 * Filters the website ticks one box at a time and the api takes as one list. The top box of each
 * counts upwards - "5 o piu locali", "3 o piu bagni" - and the api reads its own top value the
 * same way.
 */
const COUNTED = {
  'monolocali-1': ['bedrooms', '1'],
  'bilocali-2': ['bedrooms', '2'],
  'trilocali-3': ['bedrooms', '3'],
  'quadrilocali-4': ['bedrooms', '4'],
  '5-locali-o-piu': ['bedrooms', '5'],
  'bagno-1': ['bathrooms', '1'],
  'bagno-2': ['bathrooms', '2'],
  'bagno-3': ['bathrooms', '3'],
  'case-indipendenti': ['subTypology', 'independantHouse'],
  'ville-indipendenti': ['subTypology', 'villa'],
  'villette-a-schiera': ['subTypology', 'terracedHouse'],
  'villette-bifamiliari': ['subTypology', 'semidetachedHouse'],
};

/**
 * The condition of the building. The website ticks these one at a time and means their union; the
 * api takes one value and refuses a list, so a url naming several is run once per value and the
 * answers are merged. The name is what the caller looks for to know a search has to be split.
 */
export const CONDITION_PARAM = 'preservation';

/** Filters that are either set or not. */
const SWITCHES = {
  ascensori: ['elevator', '1'],
  balcone: ['balcony', '1'],
  giardino: ['garden', '1'],
  piscina: ['swimmingPool', '1'],
  animali: ['petsAllowed', '1'],
  ariacondizionata: ['airConditioning', '1'],
  'armadi-muro': ['builtinWardrobes', '1'],
  ripostiglio: ['storeRoom', '1'],
  lusso: ['luxury', '1'],
  'vista-mare': ['seaViews', '1'],
  garage: ['garage', '1'],
  'solo-appartamenti': ['flat', '1'],
  attici: ['penthouse', '1'],
  'appartamenti-due-livelli': ['duplex', '1'],
  'casali-o-cascine': ['countryHouse', '1'],
  'nuova-costruzione': [CONDITION_PARAM, 'newdevelopment'],
  'buono-stato': [CONDITION_PARAM, 'good'],
  ristrutturare: [CONDITION_PARAM, 'renew'],
  'piano-terra': ['floorHeights', 'groundFloor'],
  'piani-intermedi': ['floorHeights', 'intermediateFloor'],
  'ultimo-piano': ['floorHeights', 'topFloor'],
  arredamento_ammobiliato: ['furnished', 'furnished'],
  'arredamento_solo-cucina-arredata': ['furnished', 'furnishedKitchen'],
};

/**
 * Read the category segment of a search url.
 *
 * @param {string} segment For example `vendita-case`.
 * @returns {{operation: string, propertyType: string}|null} null when the category is one the api
 *   does not serve
 */
export function readCategory(segment) {
  const separator = segment.indexOf('-');
  if (separator < 0) return null;

  const operation = OPERATIONS[segment.slice(0, separator)];
  const propertyType = CATEGORIES[segment.slice(separator + 1)];
  return operation == null || propertyType == null ? null : { operation, propertyType };
}

/**
 * @param {string} token One filter, as the url spells it.
 * @returns {[string, string]|null} the api parameter it sets, or null when it has none
 */
function readFilter(token) {
  if (SWITCHES[token] != null) return /** @type {[string, string]} */ (SWITCHES[token]);
  if (COUNTED[token] != null) return /** @type {[string, string]} */ (COUNTED[token]);

  for (const { pattern, name } of NUMBERED) {
    const match = token.match(pattern);
    if (match != null) return [name, match[1]];
  }
  return null;
}

/**
 * Translate the filter segment of a search url.
 *
 * @param {string} segment The segment, `con-` and all, or an empty string when the url has none.
 * @returns {Array<Array<[string, string]>>|null} one parameter set per search that has to be run -
 *   more than one only when the url names several building conditions - or null when a filter has
 *   no counterpart and the search therefore cannot be asked of the api at all
 */
export function readFilters(segment) {
  if (segment === '') return [[]];

  /** @type {Map<string, string[]>} */
  const params = new Map();
  for (const token of segment.replace(/^con-/, '').split(',')) {
    const filter = readFilter(token);
    if (filter == null) return null;

    const [name, value] = filter;
    const held = params.get(name);
    if (held == null) params.set(name, [value]);
    // Only the filters the website ticks box by box stack; a second value for anything else means
    // the url said two different things, which is not a search this can carry over faithfully.
    else if (COUNTED[token] != null || name === CONDITION_PARAM) held.push(value);
    else if (!held.includes(value)) return null;
  }

  const conditions = params.get(CONDITION_PARAM) ?? [];
  params.delete(CONDITION_PARAM);
  const common = /** @type {Array<[string, string]>} */ ([...params].map(([name, values]) => [name, values.join(',')]));

  // Asking for a shape of house is already asking for a house, and the api reads the two together
  // as the wider of them, so the shape is left to speak for itself.
  if (params.has('subTypology')) {
    const withoutChalet = common.filter(([name]) => name !== 'chalet');
    return conditions.length === 0
      ? [withoutChalet]
      : conditions.map((condition) => [...withoutChalet, [CONDITION_PARAM, condition]]);
  }

  return conditions.length === 0 ? [common] : conditions.map((condition) => [...common, [CONDITION_PARAM, condition]]);
}
