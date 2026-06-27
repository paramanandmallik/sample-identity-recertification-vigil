/**
 * Append-only, hash-chained evidence store. One chain per resource ARN.
 * Each record links to the previous via prevHash, giving tamper-evidence. When
 * EVIDENCE_BUCKET is set, each record is mirrored to S3 (Object Lock / WORM) for retention.
 * @module core/evidence
 */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.mjs';
import { keys, ENTITY } from './models.mjs';
import { chainHash, genesisHash, verifyChain } from '../lib/hash.mjs';
import { isoString, epochMs } from '../lib/time.mjs';
import { config } from '../lib/config.mjs';
import { log } from '../lib/http.mjs';

/** Get the most recent evidence hash for a resource (genesis if none). */
const latestHash = async (resourceArn, client) => {
  const { PK, SKPrefix } = keys.evidencePrefix(resourceArn);
  const r = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK, ':sk': SKPrefix },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return r.Items?.[0]?.evidenceHash || genesisHash();
};

/**
 * Append an evidence record to a resource's chain.
 * @param {{resourceArn:string, eventType:string, fields:object}} input
 * @param {{ddb?:object}} [deps]
 * @returns {Promise<{evidenceHash:string, prevHash:string, ts:string}>}
 */
export const appendEvidence = async ({ resourceArn, eventType, fields = {} }, deps = {}) => {
  const client = deps.ddb || ddb;
  const ts = isoString();
  const prevHash = await latestHash(resourceArn, client);
  const hashedFields = { resourceArn, eventType, ts, ...fields };
  const evidenceHash = chainHash(hashedFields, prevHash);

  const item = {
    ...keys.evidence(resourceArn, ts),
    GSI1PK: `TYPE#${ENTITY.EVIDENCE}`,
    GSI1SK: ts,
    entityType: ENTITY.EVIDENCE,
    resourceArn,
    eventType,
    fields: hashedFields,
    prevHash,
    evidenceHash,
    createdAt: ts,
    createdAtEpoch: epochMs(),
  };
  await client.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  if (config.evidenceBucket) {
    try {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client({});
      await s3.send(new PutObjectCommand({
        Bucket: config.evidenceBucket,
        Key: `evidence/${encodeURIComponent(resourceArn)}/${ts}.json`,
        Body: JSON.stringify(item),
        ContentType: 'application/json',
      }));
    } catch (e) {
      log('error', 'EVIDENCE_S3_WRITE_FAILED', { resourceArn, message: e.message });
    }
  }

  return { evidenceHash, prevHash, ts };
};

/** Read the full ordered evidence chain for a resource. */
export const getChain = async (resourceArn, deps = {}) => {
  const client = deps.ddb || ddb;
  const { PK, SKPrefix } = keys.evidencePrefix(resourceArn);
  const r = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK, ':sk': SKPrefix },
    ScanIndexForward: true,
  }));
  return r.Items || [];
};

/** Verify a resource's evidence chain is intact. */
export const verifyResourceChain = async (resourceArn, deps = {}) => {
  const records = await getChain(resourceArn, deps);
  return verifyChain(records.map((r) => ({ fields: r.fields, prevHash: r.prevHash, evidenceHash: r.evidenceHash })));
};
