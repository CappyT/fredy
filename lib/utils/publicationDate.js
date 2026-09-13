/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Parse an explicit ISO timestamp with a timezone, or epoch milliseconds.
 * @param {unknown} value The portal's publication timestamp.
 * @returns {number|undefined} Epoch milliseconds, or undefined for an invalid date.
 */
export function publicationDate(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!iso) return undefined;
  const [, year, month, day] = iso.map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

/**
 * The formatter that reads an instant back as the wall clock of a zone. Building one is expensive
 * enough to be worth keeping, and a run reads a whole page of adverts through the same zone.
 */
const zoneReaders = new Map();

function zoneReader(timeZone) {
  let reader = zoneReaders.get(timeZone);
  if (reader == null) {
    reader = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneReaders.set(timeZone, reader);
  }
  return reader;
}

/**
 * What the zone was offset from UTC by at that instant, in milliseconds.
 *
 * @param {number} instant Epoch milliseconds.
 * @param {string} timeZone An IANA zone name.
 * @returns {number} The offset, positive east of Greenwich.
 */
function offsetAt(instant, timeZone) {
  const parts = {};
  for (const { type, value } of zoneReader(timeZone).formatToParts(instant)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
}

/**
 * Read a wall clock that names no zone as a time in the zone it was written in.
 *
 * A portal that stamps `14:30` means half past two where its offices are, and half the year that is
 * two hours off UTC rather than one. Reading such a stamp as UTC puts an advert edited this
 * afternoon in the future, which is what `Date.now()` comparisons downstream trip over.
 *
 * The offset has to be looked up at the instant the stamp names, not at the moment of reading, or a
 * summer advert read in winter lands an hour out. It is looked up twice because the first lookup
 * can only guess the instant: on the two days a year the clocks move, the guess and the answer sit
 * on different sides of the change.
 *
 * @param {{year: number, month: number, day: number, hour?: number, minute?: number, second?: number}} wallClock
 *   The stamp as written, with a one-based month.
 * @param {string} timeZone The IANA zone the portal writes its stamps in.
 * @returns {number} Epoch milliseconds.
 */
export function wallClockInZone({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = asUtc - offsetAt(asUtc, timeZone);
  return asUtc - offsetAt(guess, timeZone);
}

/**
 * Parse a portal's local calendar date or timestamp in its own timezone.
 * @param {unknown} value YYYY-MM-DD, DD.MM.YYYY, or YYYY-MM-DD HH:mm:ss.
 * @param {string} timeZone The portal's IANA timezone.
 * @returns {number|undefined} Epoch milliseconds, or undefined for an invalid date.
 */
export function localPublicationDate(value, timeZone) {
  if (typeof value !== 'string') return undefined;
  const explicit = publicationDate(value);
  if (explicit != null) return explicit;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!iso && !german) return undefined;
  const [year, month, day] = iso ? iso.slice(1, 4).map(Number) : [german[3], german[2], german[1]].map(Number);
  // A portal date without a time represents midnight in the portal's timezone.
  const parts = [year, month, day, Number(iso?.[4] ?? 0), Number(iso?.[5] ?? 0), Number(iso?.[6] ?? 0)];
  const utc = Date.UTC(year, month - 1, day, ...parts.slice(3));
  const check = new Date(utc);
  if (
    !Number.isFinite(utc) ||
    utc <= 0 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== parts[3] ||
    check.getUTCMinutes() !== parts[4] ||
    check.getUTCSeconds() !== parts[5]
  )
    return undefined;

  try {
    const [hour, minute, second] = parts.slice(3);
    const timestamp = wallClockInZone({ year, month, day, hour, minute, second }, timeZone);
    // A wall clock skipped by a DST change does not read back as itself.
    return timestamp + offsetAt(timestamp, timeZone) === utc ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a German relative portal date.
 * Ages below a day keep their minute, "Heute, 09:30" and "Gestern, 17:30" keep their local time,
 * and anything coarser resolves to midnight on the calculated local day.
 * @param {unknown} value The portal's relative date text.
 * @param {string} timeZone The portal's IANA timezone.
 * @param {number} [referenceTime] Time the response was received, in epoch milliseconds.
 * @returns {number|undefined} Epoch milliseconds, or undefined for unrecognized text.
 */
export function relativePublicationDate(value, timeZone, referenceTime = Date.now()) {
  if (typeof value !== 'string' || publicationDate(referenceTime) == null) return undefined;
  const text = value.trim();
  const namedDay = /^(Heute|Gestern)(?:,\s*([01]?\d|2[0-3]):([0-5]\d))?$/i.exec(text);
  const units = {
    second: 0,
    minute: 0,
    hour: 0,
    day: namedDay?.[1].toLowerCase() === 'gestern' ? 1 : 0,
    week: 0,
    month: 0,
    year: 0,
  };
  if (!namedDay) {
    const names = {
      sekunde: 'second',
      minute: 'minute',
      stunde: 'hour',
      tag: 'day',
      woche: 'week',
      monat: 'month',
      jahr: 'year',
    };
    for (const part of text.replace(/^vor\s+/i, '').split(/,\s*/)) {
      const match = /^(\d+|einer?|einem)\s+(Sekunde|Minute|Stunde|Tag|Woche|Monat|Jahr)(?:n|en|e)?$/i.exec(part);
      if (!match) return undefined;
      const amount = /^ein/i.test(match[1]) ? 1 : Number(match[1]);
      if (!Number.isSafeInteger(amount)) return undefined;
      units[names[match[2].toLowerCase()]] += amount;
    }
  }
  const elapsed = ((units.hour * 60 + units.minute) * 60 + units.second) * 1000;
  if (!namedDay && units.day + units.week + units.month + units.year === 0) {
    return publicationDate(Math.floor((referenceTime - elapsed) / 60000) * 60000);
  }
  try {
    const fields = Object.fromEntries(
      zoneReader(timeZone)
        .formatToParts(referenceTime - elapsed)
        .map(({ type, value }) => [type, value]),
    );
    const calendar = new Date(Date.UTC(Number(fields.year) - units.year, Number(fields.month) - 1 - units.month, 1));
    const lastDay = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, 0)).getUTCDate();
    calendar.setUTCDate(Math.min(Number(fields.day), lastDay) - units.day - units.week * 7);
    const day = calendar.toISOString().slice(0, 10);
    const midnight = localPublicationDate(day, timeZone);
    if (namedDay?.[2] == null) return midnight;
    // A local time skipped by the DST change falls back to the day.
    return localPublicationDate(`${day} ${namedDay[2].padStart(2, '0')}:${namedDay[3]}`, timeZone) ?? midnight;
  } catch {
    return undefined;
  }
}
