/**
 * Roll a resource back to a captured before-state snapshot via its connector.
 * Records a ROLLBACK_APPLIED evidence link. Used by admin recovery (POST /rollback).
 * @module core/rollback
 */

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.mjs';
import { keys } from './models.mjs';
import { appendEvidence } from './evidence.mjs';
import { getConnector } from '../connectors/registry.mjs';
import { buildClients as defaultBuildClients } from '../lib/aws-clients.mjs';

/** Load a specific snapshot (by SK) or the most recent one for a resource. */
const loadSnapshot = async (client, resourceArn, snapshotSK) => {
  if (snapshotSK) {
    const { Item } = await client.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: keys.snapshot(resourceArn, '').PK, SK: snapshotSK } }));
    return Item || null;
  }
  const { PK, SKPrefix } = keys.snapshotPrefix(resourceArn);
  const r = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK, ':sk': SKPrefix },
    ScanIndexForward: false, Limit: 1,
  }));
  return r.Items?.[0] || null;
};

/**
 * @param {{resourceArn:string, snapshotSK?:string}} input
 * @param {{ddb?:object, buildClients?:Function, getConnector?:Function}} [deps]
 */
export const rollbackResource = async ({ resourceArn, snapshotSK }, deps = {}) => {
  const client = deps.ddb || ddb;
  const buildClients = deps.buildClients || defaultBuildClients;
  const resolve = deps.getConnector || getConnector;

  const snap = await loadSnapshot(client, resourceArn, snapshotSK);
  if (!snap) return { error: 'No snapshot found for resource' };

  const connector = resolve(snap.resourceType);
  if (!connector) return { error: `No connector for resourceType ${snap.resourceType}` };

  const clients = await buildClients(snap.accountId);
  const ctx = { resourceArn, resourceType: snap.resourceType, clients, accountId: clients.accountId };
  const result = await connector.rollback(ctx, snap.beforeState);

  await appendEvidence({ resourceArn, eventType: 'ROLLBACK_APPLIED', fields: { snapshotSK: snap.SK, actions: result.actions } }, { ddb: client });
  return { resourceArn, snapshotSK: snap.SK, actions: result.actions, note: result.note };
};
