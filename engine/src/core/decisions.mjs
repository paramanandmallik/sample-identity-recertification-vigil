/**
 * Decision intake. Validates owner decisions, enriches them from the stored review item
 * (resourceType, accessInfo, per-principal accessSource), persists an immutable decision
 * record with a deterministic id (idempotency), and enqueues enforcement.
 * @module core/decisions
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.mjs';
import { keys, ENTITY, DECISION, initialEnforcement, isValidDecision, decisionId as mkId } from './models.mjs';
import { isoString, epochMs } from '../lib/time.mjs';
import { config } from '../lib/config.mjs';

const enqueue = async (decisionId, deps) => {
  if (deps.enqueue) return deps.enqueue(decisionId);
  if (!config.enforcementQueueUrl) return;
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const sqs = deps.sqs || new SQSClient({});
  const msg = { QueueUrl: config.enforcementQueueUrl, MessageBody: JSON.stringify({ decisionId }) };
  if (config.enforcementQueueUrl.endsWith('.fifo')) {
    // FIFO-only params; standard queues reject these. Idempotency is also guaranteed
    // by the deterministic decisionId + enforcer status guard.
    msg.MessageGroupId = decisionId;
    msg.MessageDeduplicationId = decisionId;
  }
  await sqs.send(new SendMessageCommand(msg));
};

/**
 * @param {{cycleId:string, ownerEmail:string, actorId?:string, onBehalfOf?:string, decisions:Array}} input
 * @param {{ddb?:object, enqueue?:Function, sqs?:object}} [deps]
 * @returns {Promise<{results:Array}>}
 */
export const recordDecisions = async ({ cycleId, ownerEmail, actorId, onBehalfOf, decisions }, deps = {}) => {
  const client = deps.ddb || ddb;
  if (!cycleId || !ownerEmail || !Array.isArray(decisions) || decisions.length === 0) {
    return { error: 'cycleId, ownerEmail and decisions[] are required' };
  }

  const results = [];
  for (const dec of decisions) {
    const resourceArn = dec.resourceArn;
    const principalArn = dec.principalArn || null;
    if (!resourceArn || !isValidDecision(dec.decision)) {
      results.push({ resourceArn, principalArn, status: 'INVALID', error: 'resourceArn and a valid decision are required' });
      continue;
    }

    const { Item: review } = await client.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.reviewItem(ownerEmail, cycleId, resourceArn) }));
    if (!review) {
      results.push({ resourceArn, principalArn, status: 'NOT_FOUND', error: 'No review item for this owner/cycle/resource' });
      continue;
    }

    let accessSource;
    if (principalArn) {
      const entry = (review.accessEntries || []).find((e) => e.principalArn === principalArn);
      if (!entry) {
        results.push({ resourceArn, principalArn, status: 'INVALID', error: 'principal not found in resource accessEntries' });
        continue;
      }
      accessSource = entry.accessSource;
    }

    const id = mkId(cycleId, resourceArn, principalArn || '_resource_');
    const now = isoString();
    const item = {
      ...keys.decision(id),
      GSI1PK: `TYPE#${ENTITY.DECISION}`,
      GSI1SK: `${cycleId}#${now}`,
      entityType: ENTITY.DECISION,
      decisionId: id,
      cycleId, ownerEmail, actorId: actorId || ownerEmail, onBehalfOf: onBehalfOf || null,
      resourceArn, resourceType: review.resourceType, principalArn, accessSource,
      accessInfo: review.accessInfo || null,
      decision: dec.decision,
      reason: dec.reason || null,
      changes: dec.changes || null,
      accountId: review.accountId || null,
      enforcementStatus: initialEnforcement(dec.decision),
      createdAt: now, createdAtEpoch: epochMs(),
    };

    try {
      await client.send(new PutCommand({ TableName: TABLE_NAME, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        results.push({ resourceArn, principalArn, decisionId: id, status: 'DUPLICATE', error: 'decision already recorded for this resource/principal/cycle' });
        continue;
      }
      throw e;
    }

    await enqueue(id, deps);
    results.push({ resourceArn, principalArn, decisionId: id, decision: dec.decision, status: 'QUEUED' });
  }

  return { results };
};
