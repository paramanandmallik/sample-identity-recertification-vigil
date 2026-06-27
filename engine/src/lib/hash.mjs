/**
 * Cryptographic primitives for the tamper-evident evidence chain.
 * Each evidence record's hash covers its canonical fields plus the previous record's
 * hash, forming an append-only chain per resource.
 * @module lib/hash
 */

import { createHash } from 'node:crypto';

const GENESIS = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

/** Canonical, key-sorted JSON so hashing is stable regardless of property order. */
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
};

/** SHA-256 hex digest of a string, prefixed with "sha256:". */
export const sha256 = (data) => `sha256:${createHash('sha256').update(data, 'utf8').digest('hex')}`;

/** Genesis (first-link) hash for a new chain. */
export const genesisHash = () => GENESIS;

/**
 * Compute a chained evidence hash.
 * @param {object} fields - Identity-critical fields of the record (order-independent).
 * @param {string} [prevHash] - Previous record's evidenceHash; defaults to genesis.
 * @returns {string} sha256-prefixed digest.
 */
export const chainHash = (fields, prevHash = GENESIS) =>
  sha256(`${canonical(fields)}|${prevHash}`);

/**
 * Verify a contiguous chain of evidence records (each must carry evidenceHash + prevHash
 * + the canonical `fields` used to compute it).
 * @param {Array<{fields: object, prevHash: string, evidenceHash: string}>} records - ordered oldest->newest
 * @returns {{ valid: boolean, brokenAt?: number }}
 */
export const verifyChain = (records) => {
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.prevHash !== prev) return { valid: false, brokenAt: i };
    if (chainHash(r.fields, r.prevHash) !== r.evidenceHash) return { valid: false, brokenAt: i };
    prev = r.evidenceHash;
  }
  return { valid: true };
};
