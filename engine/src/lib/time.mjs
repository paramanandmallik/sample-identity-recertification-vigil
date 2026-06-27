/**
 * Time utilities. Internally everything is UTC ISO-8601 + epoch ms.
 * @module lib/time
 */

/** UTC ISO-8601 string for a Date or date-like input. */
export const isoString = (date = new Date()) =>
  (date instanceof Date ? date : new Date(date)).toISOString();

/** Epoch milliseconds for a Date or date-like input. */
export const epochMs = (date = new Date()) =>
  (date instanceof Date ? date : new Date(date)).getTime();

/** Add N days to a Date, returning a new Date. */
export const addDays = (date, days) =>
  new Date((date instanceof Date ? date : new Date(date)).getTime() + days * 86400000);

/** TTL (epoch seconds) N days from now, for DynamoDB TTL attributes. */
export const ttlInDays = (days) => Math.floor(Date.now() / 1000) + days * 86400;
