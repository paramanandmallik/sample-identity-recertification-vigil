/**
 * End-to-end smoke test against the DEPLOYED engine.
 * Creates a throwaway S3 bucket with a bucket-policy grant, seeds a review item,
 * records a REVOKE decision (which enqueues to the real SQS queue so the deployed
 * enforcer Lambda performs the change), then verifies the bucket policy was scoped-
 * stripped, the decision reached ENFORCED, and the evidence chain is intact.
 * Cleans up the bucket at the end.
 *
 * Run: AWS_PROFILE=default TABLE_NAME=RecertEngine-dev ENFORCEMENT_QUEUE_URL=... \
 *      AWS_REGION=us-east-1 MANAGEMENT_ACCOUNT_ID=364170696417 node engine/scripts/smoke.mjs
 */

import { S3Client, CreateBucketCommand, PutBucketPolicyCommand, PutBucketTaggingCommand, GetBucketPolicyCommand, DeleteBucketCommand, DeleteBucketPolicyCommand } from '@aws-sdk/client-s3';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../src/lib/ddb.mjs';
import { keys, ENTITY, REVIEW, decisionId } from '../src/core/models.mjs';
import { recordDecisions } from '../src/core/decisions.mjs';
import { getChain, verifyResourceChain } from '../src/core/evidence.mjs';

const ACCOUNT = process.env.MANAGEMENT_ACCOUNT_ID || '364170696417';
const ROOT = `arn:aws:iam::${ACCOUNT}:root`;
const CYCLE = 'SMOKE-1';
const OWNER = 'smoke-owner@example.com';
const bucket = `recert-engine-smoke-${Date.now()}`;
const arn = `arn:aws:s3:::${bucket}`;
const s3 = new S3Client({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const policy = { Version: '2012-10-17', Statement: [{ Sid: 'SmokeGrant', Effect: 'Allow', Principal: { AWS: ROOT }, Action: 's3:GetObject', Resource: `${arn}/*` }] };

const log = (...a) => console.log('[smoke]', ...a);
let failed = false;

try {
  log('table:', TABLE_NAME, 'bucket:', bucket);

  // 1. Create bucket + policy + owner tag
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
  await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: [{ Key: 'owner', Value: OWNER }] } }));
  log('1. bucket created + policy + owner tag set');

  // 2. Seed review item (as discovery would produce)
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...keys.reviewItem(OWNER, CYCLE, arn),
      GSI1PK: `TYPE#${ENTITY.REVIEW_ITEM}`, GSI1SK: `${CYCLE}#${REVIEW.PENDING}`,
      entityType: ENTITY.REVIEW_ITEM, cycleId: CYCLE, ownerEmail: OWNER,
      resourceArn: arn, resourceType: 's3:bucket', service: 's3', resourceName: bucket,
      accountId: ACCOUNT, status: REVIEW.PENDING,
      accessInfo: { bucketPolicy: policy, publicAccessBlock: null, acl: null },
      accessEntries: [{ principalArn: ROOT, principalName: ACCOUNT, principalType: 'AWS_ACCOUNT', accessSource: 'BUCKET_POLICY', permissions: ['s3:GetObject'] }],
    },
  }));
  log('2. review item seeded');

  // 3. Record REVOKE decision -> enqueues to real SQS -> deployed enforcer acts
  const res = await recordDecisions({ cycleId: CYCLE, ownerEmail: OWNER, decisions: [{ resourceArn: arn, principalArn: ROOT, decision: 'REVOKE', reason: 'smoke test' }] });
  log('3. recordDecisions:', JSON.stringify(res.results));
  const id = decisionId(CYCLE, arn, ROOT);

  // 4. Poll decision status until terminal
  let status; let actions;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.decision(id) }));
    status = Item?.enforcementStatus; actions = Item?.actions;
    if (['ENFORCED', 'FAILED', 'TICKETED', 'NOT_REQUIRED'].includes(status)) break;
  }
  log('4. enforcement status:', status, 'actions:', JSON.stringify(actions || []));
  if (status !== 'ENFORCED') { failed = true; log('   ✗ expected ENFORCED'); }

  // 5. Verify the bucket policy was actually changed (principal stripped -> policy deleted)
  let policyGone = false;
  try { await s3.send(new GetBucketPolicyCommand({ Bucket: bucket })); }
  catch (e) { if (e.name === 'NoSuchBucketPolicy') policyGone = true; else throw e; }
  log('5. bucket policy removed by enforcer:', policyGone);
  if (!policyGone) failed = true;

  // 6. Evidence chain
  const chain = await getChain(arn);
  const v = await verifyResourceChain(arn);
  log('6. evidence events:', chain.map((c) => c.eventType).join(' -> '), '| chain valid:', JSON.stringify(v));
  if (!v.valid) failed = true;
} catch (e) {
  failed = true;
  log('ERROR:', e.name, e.message);
} finally {
  // Cleanup bucket
  try { await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket })); } catch { /* may be gone */ }
  try { await s3.send(new DeleteBucketCommand({ Bucket: bucket })); log('cleanup: bucket deleted'); } catch (e) { log('cleanup warn:', e.message); }
  log(failed ? 'RESULT: FAIL ✗' : 'RESULT: PASS ✓');
  process.exit(failed ? 1 : 0);
}
