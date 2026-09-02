/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';

import { parseAddress, coveragePath } from '../../../lib/services/connectivity/client/navigabeneClient.js';
import { normalizeItalian, IT_TECHNOLOGIES } from '../../../lib/services/connectivity/normalize.js';

/**
 * The Italian coverage checker answers per address, so the work a test can pin without the network
 * is the reading of an address and the reading of its answer - plus the request the verdict is
 * asked in, whose base64 context is what makes the checker quote the address back.
 */
describe('services/connectivity/navigabeneClient', () => {
  describe('the address a listing carries', () => {
    it('reads street, civic number and town', () => {
      expect(parseAddress('Via San Francesco, 3, Chiuduno')).toEqual({
        street: 'Via San Francesco',
        civic: '3',
        town: 'Chiuduno',
      });
      expect(parseAddress('Via Torino, Bolgare')).toEqual({ street: 'Via Torino', civic: null, town: 'Bolgare' });
    });

    it('drops the district that sits between the street and the town', () => {
      expect(parseAddress('Via Tito Vignoli s.n.c, Lorenteggio, Milano')).toEqual({
        street: 'Via Tito Vignoli',
        civic: null,
        town: 'Milano',
      });
    });

    it('lifts a civic number that rides on the street itself', () => {
      expect(parseAddress('Via Al Poggio 1/X, Ranzanico')).toEqual({
        street: 'Via Al Poggio',
        civic: '1/X',
        town: 'Ranzanico',
      });
      expect(parseAddress('Via Roma 12/A, Bergamo')).toEqual({ street: 'Via Roma', civic: '12/A', town: 'Bergamo' });
      expect(parseAddress('Via San Francesco 3, Chiuduno')).toEqual({
        street: 'Via San Francesco',
        civic: '3',
        town: 'Chiuduno',
      });
    });

    it('reads a street whose name a particella also starts, and one that ends in a number', () => {
      // "Belvedere" is on the checker's own list of street prefixes, and a house number that rides
      // on the street is a civic number and not part of the name - a street called "Belvedere 10"
      // exists, and the checker keeps the two apart exactly this way.
      expect(parseAddress('Via Belvedere 10, Bolgare')).toEqual({
        street: 'Via Belvedere',
        civic: '10',
        town: 'Bolgare',
      });
    });

    it('has no answer for an address that names no town', () => {
      expect(parseAddress('Via Torino')).toBeNull();
      expect(parseAddress(undefined)).toBeNull();
      expect(parseAddress('')).toBeNull();
    });
  });

  describe('the request a verdict is asked in', () => {
    it('carries the address the checker itself would assemble', () => {
      const path = coveragePath({
        egon: '380100035940697',
        istat: '016073',
        particella: 'VIA',
        civico: '3',
        strada: 'SAN FRANCESCO',
        town: 'CHIUDUNO',
      });

      expect(path).toContain('/copertura/get/b01fdb33-0011-4158-8f90-3702c74d5fae/380100035940697/016073/');
      const encoded = path.split('/').at(-1);
      const context = JSON.parse(Buffer.from(decodeURIComponent(/** @type {string} */ (encoded)), 'base64').toString());
      expect(context).toEqual({
        particella: 'VIA',
        civico: '3',
        strada: 'SAN FRANCESCO',
        codice_istat: '016073',
        comune: 'CHIUDUNO',
      });
    });
  });

  describe('the answer a verdict is read from', () => {
    it('reads the fastest offer per technology', () => {
      const connectivity = normalizeItalian([
        { technology: 'VDSL', download_speed: 74 },
        { technology: 'EVDSL', download_speed: 102 },
        { technology: 'FTTH', download_speed: 2500 },
        { technology: 'FTTHNB', download_speed: 1000 },
        { technology: 'FWA', download_speed: 30 },
      ]);

      expect(connectivity.maxDownMbit).toBe(2500);
      expect(connectivity.fiber).toBe(true);
      expect(connectivity.technologies).toEqual({
        ftthb: { maxDownMbit: 2500, sharePercent: null },
        fttc: { maxDownMbit: 102, sharePercent: null },
        fwa: { maxDownMbit: 30, sharePercent: null },
      });
      expect(connectivity.source).toBe('it-navigabene');
    });

    it('reads an unserved address as a verdict rather than a gap', () => {
      const connectivity = normalizeItalian([]);

      expect(connectivity.maxDownMbit).toBeNull();
      expect(connectivity.fiber).toBe(false);
      expect(connectivity.technologies).toEqual({});
    });

    it('leaves out what it cannot read', () => {
      expect(normalizeItalian(null).technologies).toEqual({});
      expect(normalizeItalian([{ technology: 'FTTH', download_speed: 0 }]).fiber).toBe(false);
      expect(normalizeItalian([{ technology: 'SONOALTRO', download_speed: 100 }]).technologies).toEqual({});
    });

    it('maps both fibre codes onto the one fibre answer', () => {
      expect(IT_TECHNOLOGIES).toEqual({ FTTH: 'ftthb', FTTHNB: 'ftthb', EVDSL: 'fttc', VDSL: 'fttc', FWA: 'fwa' });
    });
  });
});
