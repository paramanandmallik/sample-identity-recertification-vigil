/**
 * recert-api Lambda. The single integration surface for client UIs.
 *   POST /cycles                      - start a cycle (triggers async discovery)
 *   GET  /cycles/{cycleId}            - cycle summary + per-owner progress
 *   GET  /reviews?cycleId=            - current owner's review items
 *   POST /decisions                   - submit certify/modify/revoke (enqueues enforcement)
 *   GET  /decisions/{decisionId}      - enforcement status
 *   GET  /resources/{arn}/snapshots   - before-state snapshots
 *   POST /rollback                    - restore a resource to a prior snapshot (admin)
 * @module api/handler
 */

import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ddb, TABLE_NAME } from '../lib/ddb.mjs';
import { ok, fail, log } from '../lib/http.mjs';
import { keys, ENTITY, REVIEW } from '../core/models.mjs';
import { recordDecisions } from '../core/decisions.mjs';
import { rollbackResource } from '../core/rollback.mjs';
import { isoString, epochMs, addDays } from '../lib/time.mjs';
import { config } from '../lib/config.mjs';

const lambda = new LambdaClient({});

const ownerOf = (event) => {
  const c = event.requestContext?.authorizer?.claims;
  return c?.email || c?.['cognito:username'] || c?.sub || null;
};
const groupsOf = (event) => {
  const g = event.requestContext?.authorizer?.claims?.['cognito:groups'];
  return Array.isArray(g) ? g : (typeof g === 'string' ? g.split(',') : []);
};

export const handler = async (event) => {
  try {
    const { httpMethod, path, pathParameters } = event;
    if (httpMethod === 'POST' && path === '/cycles') return await createCycle(event);
    if (httpMethod === 'GET' && path === '/cycles') return await listCycles();
    if (httpMethod === 'GET' && pathParameters?.cycleId) return await getCycle(pathParameters.cycleId);
    if (httpMethod === 'GET' && path === '/reviews') return await getReviews(event);
    if (httpMethod === 'POST' && path === '/decisions') return await postDecisions(event);
    if (httpMethod === 'GET' && pathParameters?.decisionId) return await getDecision(pathParameters.decisionId);
    if (httpMethod === 'GET' && path?.includes('/snapshots')) return await getSnapshots(pathParameters?.arn);
    if (httpMethod === 'POST' && path === '/rollback') return await postRollback(event);
    return fail(404, 'Not found');
  } catch (err) {
    log('error', 'API_ERROR', { path: event.path, message: err.message });
    return fail(500, 'Internal server error');
  }
};

const createCycle = async (event) => {
  const body = JSON.parse(event.body || '{}');
  const cycleType = body.cycleType || 'QUARTERLY';
  const now = new Date();
  const cycleId = body.cycleId || (cycleType === 'QUARTERLY'
    ? `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`
    : `${now.getFullYear()}-ADHOC-${Date.now()}`);
  const deadlineDays = body.deadlineDays || config.recertDeadlineDays;

  const existing = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.cycleSummary(cycleId) }));
  if (existing.Item) return ok(200, { cycleId, status: existing.Item.status, note: 'cycle already exists' });

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...keys.cycleSummary(cycleId), entityType: ENTITY.CYCLE,
      GSI1PK: `TYPE#${ENTITY.CYCLE}`, GSI1SK: isoString(now),
      cycleId, cycleType, status: 'INITIATING',
      scope: body.scope || null,
      startDate: isoString(now), deadline: isoString(addDays(now, deadlineDays)),
      totalResources: 0, totalOwners: 0, completedCount: 0,
      createdAt: isoString(now), createdAtEpoch: epochMs(now),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  // Trigger discovery asynchronously
  if (process.env.DISCOVERY_FUNCTION) {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.DISCOVERY_FUNCTION,
      InvocationType: 'Event',
      Payload: JSON.stringify({ cycleId, cycleType, scope: body.scope || null, deadlineDays }),
    }));
  }
  return ok(202, { cycleId, status: 'INITIATING' });
};

const reviewItemsForCycle = async (cycleId) => {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME, IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TYPE#${ENTITY.REVIEW_ITEM}`, ':sk': cycleId },
  }));
  return r.Items || [];
};

const tally = (items) => {
  const t = { total: items.length, pending: 0, certified: 0, revoked: 0, modified: 0 };
  for (const i of items) {
    if (i.status === REVIEW.PENDING) t.pending++;
    else if (i.status === REVIEW.CERTIFIED) t.certified++;
    else if (i.status === REVIEW.REVOKED) t.revoked++;
    else if (i.status === REVIEW.MODIFIED || i.status === REVIEW.PARTIAL) t.modified++;
  }
  return t;
};

const completionPct = (t) => (t.total ? Math.round(((t.total - t.pending) / t.total) * 100) : 0);

const listCycles = async () => {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME, IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `TYPE#${ENTITY.CYCLE}` },
    ScanIndexForward: false,
  }));
  const cycles = [];
  for (const c of r.Items || []) {
    const stats = tally(await reviewItemsForCycle(c.cycleId));
    cycles.push({
      cycleId: c.cycleId, cycleType: c.cycleType, status: c.status,
      startDate: c.startDate, deadline: c.deadline,
      totalResources: c.totalResources ?? stats.total, totalOwners: c.totalOwners ?? 0,
      resourcesByService: c.resourcesByService || {},
      stats, completionPct: completionPct(stats),
    });
  }
  return ok(200, { cycles });
};

const getCycle = async (cycleId) => {
  const summary = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.cycleSummary(cycleId) }));
  if (!summary.Item) return fail(404, `Cycle ${cycleId} not found`);

  const items = await reviewItemsForCycle(cycleId);
  const byOwner = {};
  for (const it of items) {
    const k = it.ownerEmail || 'unknown';
    byOwner[k] = byOwner[k] || { ownerEmail: k, total: 0, pending: 0, decided: 0 };
    byOwner[k].total++;
    if (it.status === REVIEW.PENDING) byOwner[k].pending++; else byOwner[k].decided++;
  }
  const stats = tally(items);
  return ok(200, { cycle: summary.Item, stats, completionPct: completionPct(stats), ownerProgress: Object.values(byOwner) });
};

const getReviews = async (event) => {
  const owner = ownerOf(event);
  if (!owner) return fail(401, 'Owner identity required');
  const cycleId = event.queryStringParameters?.cycleId;
  const { PK, SKPrefix } = cycleId ? keys.reviewItemPrefix(owner, cycleId) : { PK: `OWNER#${owner}`, SKPrefix: 'REVIEW#' };
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK, ':sk': SKPrefix },
  }));
  return ok(200, { ownerEmail: owner, reviews: r.Items || [] });
};

const postDecisions = async (event) => {
  const owner = ownerOf(event);
  if (!owner) return fail(401, 'Owner identity required');
  const body = JSON.parse(event.body || '{}');
  const actorId = event.requestContext?.authorizer?.claims?.sub || owner;
  const result = await recordDecisions({
    cycleId: body.cycleId, ownerEmail: body.onBehalfOf || owner, actorId,
    onBehalfOf: body.onBehalfOf || null, decisions: body.decisions,
  });
  if (result.error) return fail(400, result.error);
  return ok(200, result);
};

const getDecision = async (decisionId) => {
  const r = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.decision(decisionId) }));
  if (!r.Item) return fail(404, 'Decision not found');
  const d = r.Item;
  return ok(200, {
    decisionId, decision: d.decision, resourceArn: d.resourceArn, principalArn: d.principalArn,
    enforcementStatus: d.enforcementStatus, actions: d.actions || [], applied: d.applied ?? null,
    error: d.error || null, enforcedAt: d.enforcedAt || null,
  });
};

const getSnapshots = async (arn) => {
  if (!arn) return fail(400, 'resource arn required');
  const resourceArn = decodeURIComponent(arn);
  const { PK, SKPrefix } = keys.snapshotPrefix(resourceArn);
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK, ':sk': SKPrefix },
    ScanIndexForward: false,
  }));
  return ok(200, { resourceArn, snapshots: (r.Items || []).map((s) => ({ sk: s.SK, createdAt: s.createdAt, decisionId: s.decisionId })) });
};

const postRollback = async (event) => {
  if (!groupsOf(event).includes('admin')) return fail(403, 'admin group required for rollback');
  const body = JSON.parse(event.body || '{}');
  if (!body.resourceArn) return fail(400, 'resourceArn required');
  const result = await rollbackResource({ resourceArn: body.resourceArn, snapshotSK: body.snapshotSK });
  if (result.error) return fail(400, result.error);
  return ok(200, result);
};
