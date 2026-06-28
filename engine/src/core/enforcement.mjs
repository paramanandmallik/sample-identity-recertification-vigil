/**
 * Enforcement orchestrator. Given a decision id, runs the durable pipeline:
 *   guard idempotency -> IN_PROGRESS -> snapshot -> apply (revoke|modify) -> evidence -> ENFORCED
 * Certify is NOT_REQUIRED. Unsafe/unsupported -> TICKETED. Hard failures -> FAILED + rethrow
 * so the SQS consumer retries / dead-letters. All deps are injectable for unit testing.
 * @module core/enforcement
 */

import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.mjs';
import { keys, ENTITY, DECISION, ENFORCEMENT, reviewStatusFor } from './models.mjs';
import { appendEvidence } from './evidence.mjs';
import { getConnector } from '../connectors/registry.mjs';
import { TicketRequiredError } from '../connectors/base-connector.mjs';
import { buildClients as defaultBuildClients } from '../lib/aws-clients.mjs';
import { isoString, epochMs } from '../lib/time.mjs';
import { log } from '../lib/http.mjs';

const TERMINAL = new Set([ENFORCEMENT.ENFORCED, ENFORCEMENT.NOT_REQUIRED, ENFORCEMENT.TICKETED]);

const setDecisionStatus = async (client, decisionId, status, extra = {}) => {
  const sets = ['enforcementStatus = :s'];
  const vals = { ':s': status };
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = :${k}`); vals[`:${k}`] = v; }
  await client.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: keys.decision(decisionId),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: vals,
  }));
};

const updateReviewStatus = async (client, d, status) => {
  if (!d.ownerEmail || !d.cycleId) return;
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.reviewItem(d.ownerEmail, d.cycleId, d.resourceArn),
      UpdateExpression: 'SET #st = :st, lastDecisionAt = :ts',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':st': status, ':ts': isoString() },
    }));
  } catch (e) {
    log('error', 'REVIEW_STATUS_UPDATE_FAILED', { resourceArn: d.resourceArn, message: e.message });
  }
};

/**
 * Recompute a review item's accessEntries to reflect an applied revoke/modify, so the
 * UI shows the true post-enforcement access rather than the discovery-time snapshot.
 * - REVOKE (per-principal): drop that principal's entry.
 * - REVOKE (resource-level): drop all entries.
 * - MODIFY (per-principal + removeActions): remove those actions from the principal's permissions.
 */
const pruneAccessEntries = (entries, d) => {
  if (!Array.isArray(entries)) return entries;
  if (d.decision === DECISION.REVOKE) {
    return d.principalArn ? entries.filter((e) => e.principalArn !== d.principalArn) : [];
  }
  if (d.decision === DECISION.MODIFY && d.principalArn) {
    const remove = new Set((d.changes && d.changes.removeActions) || []);
    if (remove.size) {
      return entries.map((e) => (e.principalArn === d.principalArn
        ? { ...e, permissions: (e.permissions || []).filter((p) => !remove.has(p)) }
        : e));
    }
  }
  return entries;
};

/** Set review status and, for enforced revoke/modify, prune accessEntries to match. */
const finalizeReview = async (client, d, status) => {
  if (!d.ownerEmail || !d.cycleId) return;
  const key = keys.reviewItem(d.ownerEmail, d.cycleId, d.resourceArn);
  try {
    const sets = ['#st = :st', 'lastDecisionAt = :ts'];
    const vals = { ':st': status, ':ts': isoString() };
    if (d.decision === DECISION.REVOKE || d.decision === DECISION.MODIFY) {
      const { Item } = await client.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
      if (Item && Array.isArray(Item.accessEntries)) {
        vals[':ae'] = pruneAccessEntries(Item.accessEntries, d);
        sets.push('accessEntries = :ae');
      }
    }
    await client.send(new UpdateCommand({
      TableName: TABLE_NAME, Key: key,
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: vals,
    }));
  } catch (e) {
    log('error', 'REVIEW_STATUS_UPDATE_FAILED', { resourceArn: d.resourceArn, message: e.message });
  }
};

const raiseTicket = async (client, d, reason) => {
  const ts = isoString();
  await client.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TYPE#${ENTITY.TICKET}`, SK: `${ts}#${d.resourceArn}#${d.principalArn || '_'}`,
      GSI1PK: `TYPE#${ENTITY.TICKET}`, GSI1SK: ts,
      entityType: ENTITY.TICKET, ticketStatus: 'OPEN',
      cycleId: d.cycleId, resourceArn: d.resourceArn, resourceType: d.resourceType,
      principalArn: d.principalArn || null, ownerEmail: d.ownerEmail || null,
      decision: d.decision, reason, createdAt: ts, createdAtEpoch: epochMs(),
    },
  }));
};

/**
 * Enforce a single decision. Idempotent by decision id.
 * @param {string} decisionId
 * @param {{ddb?:object, buildClients?:Function, getConnector?:Function}} [deps]
 */
export const enforceDecision = async (decisionId, deps = {}) => {
  const client = deps.ddb || ddb;
  const buildClients = deps.buildClients || defaultBuildClients;
  const resolve = deps.getConnector || getConnector;

  const { Item: d } = await client.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.decision(decisionId) }));
  if (!d) { log('error', 'ENFORCE_DECISION_NOT_FOUND', { decisionId }); return { status: 'NOT_FOUND' }; }
  if (TERMINAL.has(d.enforcementStatus)) return { status: d.enforcementStatus, idempotent: true };
  if (d.decision === DECISION.CERTIFY) {
    await appendEvidence({ resourceArn: d.resourceArn, eventType: 'ACCESS_CERTIFIED', fields: { decisionId, cycleId: d.cycleId, principalArn: d.principalArn || null } }, { ddb: client });
    await setDecisionStatus(client, decisionId, ENFORCEMENT.NOT_REQUIRED, { enforcedAt: isoString() });
    await updateReviewStatus(client, d, reviewStatusFor(d.decision));
    return { status: ENFORCEMENT.NOT_REQUIRED };
  }

  const connector = resolve(d.resourceType);
  if (!connector) {
    await raiseTicket(client, d, `No connector for resourceType ${d.resourceType}`);
    await appendEvidence({ resourceArn: d.resourceArn, eventType: 'TICKET_CREATED', fields: { decisionId, cycleId: d.cycleId, reason: 'unsupported_type' } }, { ddb: client });
    await setDecisionStatus(client, decisionId, ENFORCEMENT.TICKETED);
    await updateReviewStatus(client, d, reviewStatusFor(d.decision));
    return { status: ENFORCEMENT.TICKETED };
  }

  await setDecisionStatus(client, decisionId, ENFORCEMENT.IN_PROGRESS);

  try {
    const clients = await buildClients(d.accountId);
    const ctx = {
      resourceArn: d.resourceArn, resourceType: d.resourceType,
      principalArn: d.principalArn || undefined, accessSource: d.accessSource,
      accessInfo: d.accessInfo, changes: d.changes, clients, accountId: clients.accountId,
    };

    const before = await connector.snapshot(ctx);
    const ts = isoString();
    await client.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...keys.snapshot(d.resourceArn, ts), entityType: ENTITY.SNAPSHOT, resourceArn: d.resourceArn, resourceType: d.resourceType, accountId: clients.accountId, decisionId, beforeState: before, createdAt: ts, createdAtEpoch: epochMs() },
    }));
    await appendEvidence({ resourceArn: d.resourceArn, eventType: 'SNAPSHOT_CAPTURED', fields: { decisionId, cycleId: d.cycleId, snapshotSK: `SNAPSHOT#${ts}` } }, { ddb: client });

    const result = d.decision === DECISION.REVOKE ? await connector.revoke(ctx) : await connector.modify(ctx);

    await appendEvidence({
      resourceArn: d.resourceArn, eventType: 'CHANGE_APPLIED',
      fields: { decisionId, cycleId: d.cycleId, decision: d.decision, principalArn: d.principalArn || null, actions: result.actions, applied: result.applied },
    }, { ddb: client });
    await setDecisionStatus(client, decisionId, ENFORCEMENT.ENFORCED, { enforcedAt: isoString(), actions: result.actions, applied: result.applied });
    await finalizeReview(client, d, reviewStatusFor(d.decision));
    return { status: ENFORCEMENT.ENFORCED, actions: result.actions, applied: result.applied };
  } catch (err) {
    if (err instanceof TicketRequiredError) {
      await raiseTicket(client, d, err.message);
      await appendEvidence({ resourceArn: d.resourceArn, eventType: 'TICKET_CREATED', fields: { decisionId, cycleId: d.cycleId, reason: err.message } }, { ddb: client });
      await setDecisionStatus(client, decisionId, ENFORCEMENT.TICKETED, { ticketReason: err.message });
      await updateReviewStatus(client, d, reviewStatusFor(d.decision));
      return { status: ENFORCEMENT.TICKETED, reason: err.message };
    }
    log('error', 'ENFORCEMENT_FAILED', { decisionId, resourceArn: d.resourceArn, message: err.message });
    await appendEvidence({ resourceArn: d.resourceArn, eventType: 'ENFORCEMENT_FAILED', fields: { decisionId, cycleId: d.cycleId, error: err.message } }, { ddb: client });
    await setDecisionStatus(client, decisionId, ENFORCEMENT.FAILED, { error: err.message });
    throw err; // surface to SQS for retry / DLQ
  }
};
