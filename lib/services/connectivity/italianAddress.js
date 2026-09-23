/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * How an italian listing address is read into the parts a coverage checker asks for.
 *
 * Italy has no register that can be asked by point, so both italian sources are asked by door
 * number - and both are asked about the same addresses, printed by the same portals. This lives
 * beside the clients rather than inside one of them because a second copy of it would drift: the
 * one that gets the next odd address fixed and the other one keeps answering for the neighbour.
 */

/**
 * A civic number as the portals print it: a number, with an optional letter or pairing on it.
 *
 * "3", "12/A", "1-X", "10/BIS". Anchored where it is used, so the same shape can be matched
 * against a whole part or against the tail of a street.
 * @type {string}
 */
const CIVIC_SOURCE = String.raw`\d+(?:\s*[/\\-]\s*[0-9a-z]+)?`;

/** The whole part is a civic number. @type {RegExp} */
const CIVIC_PART = new RegExp(`^${CIVIC_SOURCE}$`, 'i');

/** A civic number riding on the end of a street name. @type {RegExp} */
const CIVIC_TRAILING = new RegExp(`\\s(${CIVIC_SOURCE})$`, 'i');

/** A range of civic numbers, "5/A fino i": its first number stays, the tail goes. @type {RegExp} */
const CIVIC_RANGE = new RegExp(`(${CIVIC_SOURCE})\\s+fino\\b[^,]*`, 'gi');

/**
 * @typedef {Object} ItalianAddress
 * @property {string} street The street with its particella, as the address spells it.
 * @property {string|null} civic The door number, where the address names one.
 * @property {string} town The town, as the address spells it.
 */

/**
 * Reads the address a listing carries into the three parts a checker asks for.
 *
 * An italian listing address reads "Via San Francesco, 3, Chiuduno" - street, civic number when
 * there is one, town - and sometimes a district sits between the street and the town ("Via Tito
 * Vignoli s.n.c, Lorenteggio, Milano"). The town is the last comma part, a trailing bare number is
 * the civic number, and the part in between is a district neither checker has a word for.
 *
 * A civic number can also ride on the street itself, "Via Al Poggio 1/X, Ranzanico", and is lifted
 * off for the same reason: a checker wants the street's name to find the street and the civic
 * number to find the building, and neither search reads the other's half.
 *
 * A building that spans several doors is printed as a range, "Via Statuto 5/A fino i, Levate". The
 * first door stands for the building, since both checkers are asked about one door.
 *
 * "s.n.c" (senza numero civico) rides on the street name; it names nothing and both checkers match
 * street names by their text, so it is dropped rather than searched for.
 *
 * @param {string|undefined} address
 * @returns {ItalianAddress|null} null when the address does not even name a street and a town,
 *   which is the minimum either checker can be asked
 */
export function parseAddress(address) {
  if (typeof address !== 'string' || address.trim() === '') return null;

  const parts = address
    .replace(CIVIC_RANGE, '$1')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return null;

  const town = parts.pop();

  let civic = null;
  if (CIVIC_PART.test(parts[parts.length - 1])) {
    civic = parts.pop();
  }

  // Whatever sits between the street and the town - "Lorenteggio" - is a district. Only the first
  // part names a street; a checker would not know what to do with the rest.
  let street = parts[0].replace(/\s+s\.?n\.?c\.?\s*$/i, '').trim();

  if (civic == null) {
    const trailing = street.match(CIVIC_TRAILING);
    if (trailing != null) {
      civic = trailing[1];
      street = street.slice(0, trailing.index).trim();
    }
  }

  if (street === '') return null;

  return { street, civic, town };
}

/**
 * Splits a label a checker printed back into the same three parts.
 *
 * The checkers answer in their own word order - fibermap's address search says "Via Al Poggio 1/X,
 * Ranzanico" while its civic-number list for the same street says "Via Al Poggio, Ranzanico 1/X" -
 * so the civic number is looked for on both ends and whichever end carries it wins.
 *
 * @param {string} label
 * @returns {ItalianAddress|null} null for a label that names no town
 */
export function parseLabel(label) {
  if (typeof label !== 'string' || label.trim() === '') return null;

  const parts = label
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return null;

  let town = parts.pop();
  let street = parts.join(' ');
  let civic = null;

  // "Via Al Poggio, Ranzanico 1/X" - the civic number sits behind the town.
  const onTown = town.match(CIVIC_TRAILING);
  if (onTown != null) {
    civic = onTown[1];
    town = town.slice(0, onTown.index).trim();
  }

  // "Via Al Poggio 1/X, Ranzanico" - it sits behind the street instead.
  if (civic == null) {
    const onStreet = street.match(CIVIC_TRAILING);
    if (onStreet != null) {
      civic = onStreet[1];
      street = street.slice(0, onStreet.index).trim();
    }
  }

  if (street === '' || town === '') return null;

  return { street, civic, town };
}

/**
 * One name written one way, so that spelling a checker and a portal disagree on is not a miss.
 *
 * Accents, punctuation and doubled spaces are all things the two sides print differently for the
 * same street - "Rio Terà" against "RIO TERA", "Via Antonio Romano'" against "Via Antonio Romano".
 * Everything that is not a letter, a digit or a space goes, and what is left is compared as one
 * upper-case string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^0-9a-z ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Two civic numbers written the same way, whatever spacing and case they were printed in.
 *
 * @param {unknown} one
 * @param {unknown} other
 * @returns {boolean}
 */
export function sameCivic(one, other) {
  const flatten = (value) =>
    String(value ?? '')
      .replace(/\s+/g, '')
      .toLowerCase();
  const left = flatten(one);
  return left !== '' && left === flatten(other);
}
