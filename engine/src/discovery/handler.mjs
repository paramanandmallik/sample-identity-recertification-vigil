/**
 * recert-discovery Lambda. Triggered on cycle creation (and by schedule). Discovers
 * resources tagged owner=<email>, enriches access details, writes one review item per
 * (owner, resource), finalizes the cycle summary, and triggers owner notifications.
 * @module discovery/handler
 */

import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import {
  S3Client, GetBucketPolicyCommand, GetPublicAccessBlockCommand, GetBucketAclCommand,
} from '@aws-sdk/client-s3';
import {
  IAMClient, ListAttachedUserPoliciesCommand, ListGroupsForUserCommand, ListAccessKeysCommand,
} from '@aws-sdk/client-iam';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.mjs';
import { keys, ENTITY, REVIEW } from '../core/models.mjs';
import { buildS3AccessEntries } from './access.mjs';
import { isoString, epochMs, addDays } from '../lib/time.mjs';
import { config, getAccountId } from '../lib/config.mjs';
import { log } from '../lib/http.mjs';

const tagging = new ResourceGroupsTaggingAPIClient({});
const s3 = new S3Client({});
const iam = new IAMClient({});
const lambda = new LambdaClient({});

const parseArn = (arn) => {
  const p = (arn || '').split(':');
  const service = p[2] || 'unknown';
  const rest = p.slice(5).join(':');
  if (service === 's3') return { service, type: `${service}:bucket`, id: rest, region: p[3] || '' };
  const [t, ...r] = rest.includes('/') ? rest.split('/') : rest.split(':');
  return { service, type: `${service}:${t || 'resource'}`, id: r.join('/') || rest, region: p[3] || '' };
};

const discover = async () => {
  const resources = [];
  let token;
  do {
    const params = { TagFilters: [{ Key: 'owner' }], ResourcesPerPage: 100 };
    if (token) params.PaginationToken = token;
    const res = await tagging.send(new GetResourcesCommand(params));
    for (const m of res.ResourceTagMappingList || []) {
      const parsed = parseArn(m.ResourceARN);
      const owner = (m.Tags || []).find((t) => t.Key === 'owner')?.Value || '';
      const tags = Object.fromEntries((m.Tags || []).map((t) => [t.Key, t.Value]));
      if (!owner) continue;
      resources.push({ arn: m.ResourceARN, ...parsed, ownerEmail: owner, tags });
    }
    token = res.PaginationToken;
  } while (token);
  return resources;
};

const enrichS3 = async (r) => {
  let bucketPolicy = null; let publicAccessBlock = null; let acl = null;
  try { const p = await s3.send(new GetBucketPolicyCommand({ Bucket: r.id })); bucketPolicy = p.Policy ? JSON.parse(p.Policy) : null; }
  catch (e) { if (e.name !== 'NoSuchBucketPolicy') log('error', 'S3_POLICY_FETCH_FAILED', { bucket: r.id, message: e.message }); }
  try { publicAccessBlock = (await s3.send(new GetPublicAccessBlockCommand({ Bucket: r.id }))).PublicAccessBlockConfiguration; }
  catch (e) { if (e.name !== 'NoSuchPublicAccessBlockConfiguration') log('error', 'S3_PAB_FETCH_FAILED', { bucket: r.id, message: e.message }); }
  try { const a = await s3.send(new GetBucketAclCommand({ Bucket: r.id })); acl = { Owner: a.Owner, Grants: a.Grants }; } catch { /* optional */ }
  r.accessInfo = { bucketPolicy, publicAccessBlock, acl };
  r.accessEntries = buildS3AccessEntries(bucketPolicy, acl);
};

const enrichIam = async (r) => {
  const user = r.id;
  try {
    const [pol, grp, keysR] = await Promise.all([
      iam.send(new ListAttachedUserPoliciesCommand({ UserName: user })),
      iam.send(new ListGroupsForUserCommand({ UserName: user })),
      iam.send(new ListAccessKeysCommand({ UserName: user })),
    ]);
    r.accessInfo = {
      attachedPolicies: (pol.AttachedPolicies || []).map((p) => ({ PolicyArn: p.PolicyArn, PolicyName: p.PolicyName })),
      groups: (grp.Groups || []).map((g) => ({ GroupName: g.GroupName })),
      accessKeys: (keysR.AccessKeyMetadata || []).map((k) => ({ AccessKeyId: k.AccessKeyId, Status: k.Status })),
    };
    r.accessEntries = [];
  } catch (e) { log('error', 'IAM_ENRICH_FAILED', { user, message: e.message }); }
};

const writeReviewItem = async (cycleId, r, deadline, now, accountId) => {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...keys.reviewItem(r.ownerEmail, cycleId, r.arn),
      GSI1PK: `TYPE#${ENTITY.REVIEW_ITEM}`, GSI1SK: `${cycleId}#${REVIEW.PENDING}`,
      entityType: ENTITY.REVIEW_ITEM,
      cycleId, ownerEmail: r.ownerEmail,
      resourceArn: r.arn, resourceType: r.type, service: r.service, resourceName: r.id,
      region: r.region || '', tags: r.tags || {},
      accessInfo: r.accessInfo || null, accessEntries: r.accessEntries || null,
      accountId, status: REVIEW.PENDING,
      deadline: isoString(deadline), createdAt: isoString(now), createdAtEpoch: epochMs(now),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  })).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
};

export const handler = async (event) => {
  const cycleId = event.cycleId;
  if (!cycleId) { log('error', 'DISCOVERY_MISSING_CYCLE', { event }); return; }
  const now = new Date();
  const deadline = addDays(now, event.deadlineDays || config.recertDeadlineDays);
  const accountId = await getAccountId();

  const resources = await discover();
  for (const r of resources) {
    if (r.service === 's3') await enrichS3(r);
    else if (r.type === 'iam:user') await enrichIam(r);
  }

  const owners = new Set();
  const byService = {};
  for (const r of resources) {
    await writeReviewItem(cycleId, r, deadline, now, accountId);
    owners.add(r.ownerEmail);
    byService[r.service] = (byService[r.service] || 0) + 1;
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME, Key: keys.cycleSummary(cycleId),
    UpdateExpression: 'SET #s = :active, totalResources = :tr, totalOwners = :to, resourcesByService = :bs, discoveredAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':active': 'ACTIVE', ':tr': resources.length, ':to': owners.size, ':bs': byService, ':now': isoString(now) },
  }));

  if (process.env.NOTIFIER_FUNCTION && resources.length > 0) {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.NOTIFIER_FUNCTION, InvocationType: 'Event',
      Payload: JSON.stringify({ action: 'INITIAL', cycleId }),
    }));
  }

  log('info', 'DISCOVERY_COMPLETE', { cycleId, totalResources: resources.length, totalOwners: owners.size });
  return { cycleId, totalResources: resources.length, totalOwners: owners.size };
};
