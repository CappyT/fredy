/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The estate agency networks of the Tecnocasa group, which share one website platform.
 *
 * Every page is server rendered around a Vue application, and each component is handed its data as
 * a JSON attribute rather than as markup: the search page carries all of a page's adverts on
 * `<estates-index :estates>`, an advert's own page carries the whole record on
 * `<estate-show-v... :estate>`. Both are read instead of the rendered cards, which spell the
 * figures as display strings and carry neither the description nor the coordinates.
 *
 * A plain request is enough - the sites put nothing in the way of one - so no browser is launched
 * for any call.
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../../utils.js';
import checkIfListingIsActive from '../listings/listingActiveTester.js';
import { extractNumber } from '../../utils/extract-number.js';
import { sanitize } from '../../utils/priceExtractors.js';
import logger from '../logger.js';
/** @import { ParsedListing } from '../../types/listing.js' */
/** @import { ProviderConfig } from '../../types/providerConfig.js' */

/**
 * A browser's user agent. The platform serves the same document either way, but a request without
 * one is the obvious thing to rate limit first.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REQUEST_HEADERS = { 'User-Agent': USER_AGENT, 'Accept-Language': 'it-IT,it;q=0.9' };

/**
 * Read a bound JSON property off the first component that carries it.
 *
 * Components are looked up by the property rather than by their element name, because the name
 * carries a version the platform bumps on its own schedule - the advert page is on `estate-show-v1`
 * today. `tagPrefix` keeps that from matching a neighbour that happens to be handed the same
 * object: an advert page passes its record to the sticky bottom bar as well.
 *
 * Cheerio decodes the entities the attribute is escaped with, so what comes back out is the JSON
 * that went in.
 *
 * @param {string|null|undefined} html the raw html of a page
 * @param {string} attribute the bound property, e.g. `:estates`
 * @param {string} [tagPrefix] element names the component may have, e.g. `estate-show`
 * @returns {any|null} the parsed value, or null when the page carries no such component
 */
export function readComponentData(html, attribute, tagPrefix) {
  if (!html) return null;

  const $ = cheerio.load(html);
  const component = $(`[\\${attribute}]`)
    .filter((_, element) => tagPrefix == null || String(element.tagName).startsWith(tagPrefix))
    .first();

  const raw = component.attr(attribute);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    logger.error(`Could not parse ${attribute} of a tecnocasa group page.`, error?.message || error);
    return null;
  }
}

/**
 * @param {string} network the brand, for the log
 * @param {string} url the search url
 * @returns {Promise<any[]>} the adverts of the first result page
 */
async function getListings(network, url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });

  if (!response.ok) {
    logger.error(`Error fetching data from ${network}: ${response.status} ${response.statusText}`);
    return [];
  }

  const estates = readComponentData(await response.text(), ':estates');
  if (!Array.isArray(estates)) {
    logger.error(`${network} returned a page without adverts. The search URL may be wrong.`);
    return [];
  }
  return estates;
}

/**
 * Turn a price as the platform writes it into a number.
 *
 * The strings are "€ 170.000" to buy and "€ 1.100 / mese" to rent, and an advert whose owner asked
 * for the figure to stay off the site says "Trattativa riservata" instead. Everything that is not a
 * digit or a separator goes first, because {@link extractNumber} parses from the front of the
 * string and gives up on the euro sign.
 *
 * @param {string|null|undefined} price the price as shown on the card
 * @returns {number|null} the price, or null when the advert names none
 */
function readPrice(price) {
  if (price == null) return null;
  return extractNumber(String(price).replace(/[^\d.,]/g, ''));
}

/**
 * Build the address the geocoder is given.
 *
 * The card writes one string - "Roma, Via Casilina - Casilina" - which is the town, the street and
 * then the quarter the agency files the street under. Nominatim answers that whole line with
 * nothing, so the quarter is dropped and the two halves are turned around into the order an
 * address is written in.
 *
 * @param {string|null|undefined} subtitle the card's subtitle
 * @returns {string|null} the address, or null when the card names no place
 */
function buildAddress(subtitle) {
  if (!subtitle) return null;

  const [city, ...rest] = String(subtitle).split(',');
  const street = rest.join(',').split(' - ')[0].replace(/\s+/g, ' ').trim();
  const town = city.replace(/\s+/g, ' ').trim();

  const address = [street, town].filter((part) => part.length > 0).join(', ');
  return address.length > 0 ? address : null;
}

/**
 * Turn an advert's description into plain text.
 *
 * The platform stores it as markup. The paragraph and line breaks have to survive as newlines: a
 * blacklisted term at the start of a line would otherwise be glued onto the end of the one before.
 *
 * @param {string|null|undefined} description the description as stored
 * @returns {string|null} the description as plain text, or null when there is none
 */
function toPlainText(description) {
  if (!description) return null;
  const withBreaks = String(description)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n');
  const text = cheerio
    .load(withBreaks)
    .root()
    .text()
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * @param {any} o one advert of the search payload
 * @returns {ParsedListing}
 */
export function normalize(o) {
  const price = readPrice(o?.price);

  return {
    id: buildHash(String(o?.id ?? ''), price == null ? null : String(price)),
    title: o?.title,
    link: o?.detail_url,
    price,
    // "75 Mq" on the card, never a number.
    size: extractNumber(o?.surface),
    // "3 locali", and "5 locali" is the upper band rather than exactly five.
    rooms: extractNumber(o?.rooms),
    address: buildAddress(o?.subtitle),
    // The card carries six cuts of the same photo; `card` is the one the search page itself shows.
    image: o?.images?.[0]?.url?.card ?? o?.images?.[0]?.url?.gallery,
    description: undefined,
  };
}

/**
 * Enrich a listing with what only its own page holds.
 *
 * The card has no description at all, so without this the blacklist has nothing but the title to
 * work on - and every title in a search reads "Trilocale in vendita". The page also names the
 * street on its own and carries the coordinates, which spares the listing a geocode.
 *
 * @param {string} network the brand, for the log
 * @param {ParsedListing} listing the listing scraped from the search page
 * @returns {Promise<ParsedListing>} the enriched listing, or the untouched one on failure
 */
async function fetchDetails(network, listing) {
  try {
    const response = await fetch(listing.link, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      logger.warn(`Could not fetch ${network} advert '${listing.id}': ${response.status} ${response.statusText}`);
      return listing;
    }

    const estate = readComponentData(await response.text(), ':estate', 'estate-show');
    if (estate == null) return listing;

    const address = [estate.address, estate.city?.title].filter(Boolean).join(', ');

    return {
      ...listing,
      address: address.length > 0 ? address : listing.address,
      description: toPlainText(estate.description) ?? listing.description,
      latitude: typeof estate.latitude === 'number' ? estate.latitude : listing.latitude,
      longitude: typeof estate.longitude === 'number' ? estate.longitude : listing.longitude,
    };
  } catch (error) {
    logger.warn(`Could not fetch ${network} advert '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * Read the current price off an advert's own page.
 *
 * `numeric_price` is the figure the card's "€ 170.000" is formatted from, so the probe and the
 * scraper always report the same number - which is what keeps a listing from logging a price change
 * the first time it is checked.
 *
 * @param {string} html the raw html of an advert page
 * @returns {number|null} the price, or null when the page carries none
 */
export function extractPrice(html) {
  return sanitize(readComponentData(html, ':estate', 'estate-show')?.numeric_price);
}

/**
 * @param {ParsedListing} o
 * @param {string[]} appliedBlackList Terms the job wants filtered out.
 * @returns {boolean}
 */
export function applyBlacklist(o, appliedBlackList) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  return o.title != null && titleNotBlacklisted && descNotBlacklisted;
}

/**
 * Build the static provider template for one brand of the group.
 *
 * @param {string} network the brand, as it is written in a log line
 * @returns {ProviderConfig} the template a provider module exports as its `config`
 */
export function createNetworkConfig(network) {
  return {
    url: null,
    requiredFieldNames: ['id', 'title', 'link', 'price', 'size', 'rooms', 'address'],
    // The adverts come from the `estates-index` payload rather than from the cards, so there is
    // nothing to crawl.
    crawlContainer: null,
    crawlFields: {},
    // The platform offers the sort in its own interface but its server ignores the parameter it
    // sets: every search comes back in the same order whichever way it is asked for, with the
    // agencies' promoted adverts first. There is nothing to send, so a search is worth keeping
    // narrow enough that a new advert lands on the first page.
    sortByDateParam: null,
    getListings: (url) => getListings(network, url),
    normalize,
    fetchDetails: (listing) => fetchDetails(network, listing),
    activityProbe: checkIfListingIsActive,
    priceTracking: {
      extract: extractPrice,
    },
  };
}
