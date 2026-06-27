/**
 * S3 bucket connector. Enforces access decisions scoped to a single bucket.
 *
 * Key correctness properties (the production fixes):
 *  - Per-principal revoke/modify never touches the principal's IAM policies. When access
 *    is granted via IAM (not the bucket policy/ACL), we add a *scoped explicit Deny* in the
 *    bucket policy for that principal — guaranteeing loss of access to THIS bucket only.
 *  - Modify removes only the specified actions (scoped), never all access.
 *  - Every mutation is preceded by a snapshot and is fully reversible via rollback().
 * @module connectors/s3-connector
 */

import {
  GetBucketPolicyCommand, PutBucketPolicyCommand, DeleteBucketPolicyCommand,
  GetPublicAccessBlockCommand, PutPublicAccessBlockCommand,
  GetBucketAclCommand, PutBucketAclCommand,
} from '@aws-sdk/client-s3';
import { BaseConnector, TicketRequiredError } from './base-connector.mjs';

const BLOCK_ALL = {
  BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
};

const bucketName = (arn) => (arn?.startsWith('arn:') ? arn.split(':::')[1]?.split('/')[0] : arn) || arn;
const denySid = (principalArn) => `RecertDeny-${principalArn.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 100);

const getPolicy = async (bucket, accessInfo, s3) => {
  if (accessInfo && 'bucketPolicy' in accessInfo) return accessInfo.bucketPolicy;
  try {
    const r = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    return r.Policy ? JSON.parse(r.Policy) : null;
  } catch (e) {
    if (e.name === 'NoSuchBucketPolicy') return null;
    throw e;
  }
};

const putOrDeletePolicy = async (bucket, policy, s3) => {
  if (!policy || !policy.Statement || policy.Statement.length === 0) {
    await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    return 'DeleteBucketPolicy';
  }
  await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
  return 'PutBucketPolicy';
};

/** Remove a principal from all Allow statements; drop statements left with no principal. */
const stripPrincipal = (policy, principalArn) => {
  const out = [];
  for (const st of policy.Statement || []) {
    if (st.Effect !== 'Allow' || !st.Principal?.AWS) { out.push(st); continue; }
    const arns = (Array.isArray(st.Principal.AWS) ? st.Principal.AWS : [st.Principal.AWS]).filter((p) => p !== principalArn);
    if (arns.length === 0) continue; // statement only granted this principal -> drop
    out.push({ ...st, Principal: { ...st.Principal, AWS: arns.length === 1 ? arns[0] : arns } });
  }
  return { ...policy, Statement: out };
};

/** Remove specific actions from a principal's Allow statements. */
const stripActions = (policy, principalArn, removeActions) => {
  const remove = new Set(removeActions);
  const out = [];
  for (const st of policy.Statement || []) {
    const principals = st.Principal?.AWS ? (Array.isArray(st.Principal.AWS) ? st.Principal.AWS : [st.Principal.AWS]) : [];
    if (st.Effect !== 'Allow' || !principals.includes(principalArn)) { out.push(st); continue; }
    const actions = (Array.isArray(st.Action) ? st.Action : [st.Action]).filter((a) => !remove.has(a));
    if (actions.length === 0) continue; // no actions left -> drop statement
    out.push({ ...st, Action: actions.length === 1 ? actions[0] : actions });
  }
  return { ...policy, Statement: out };
};

/** Merge a scoped Deny statement for a principal (replacing any prior Recert Deny for them). */
const withExplicitDeny = (policy, bucket, principalArn, actions) => {
  const base = policy && policy.Statement ? policy : { Version: '2012-10-17', Statement: [] };
  const sid = denySid(principalArn);
  const statements = (base.Statement || []).filter((s) => s.Sid !== sid);
  statements.push({
    Sid: sid,
    Effect: 'Deny',
    Principal: { AWS: principalArn },
    Action: actions.length === 1 ? actions[0] : actions,
    Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
  });
  return { ...base, Statement: statements };
};

export class S3Connector extends BaseConnector {
  static get resourceTypes() { return ['s3:bucket']; }
  static get capabilities() { return { revoke: true, modify: true, perPrincipal: true, rollback: true }; }

  async snapshot(ctx) {
    const bucket = bucketName(ctx.resourceArn);
    const s3 = ctx.clients.s3;
    if (ctx.accessInfo && ('bucketPolicy' in ctx.accessInfo)) return ctx.accessInfo;
    const out = { bucketPolicy: null, publicAccessBlock: null, acl: null };
    out.bucketPolicy = await getPolicy(bucket, null, s3);
    try { out.publicAccessBlock = (await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))).PublicAccessBlockConfiguration; }
    catch (e) { if (e.name !== 'NoSuchPublicAccessBlockConfiguration') throw e; }
    try { const a = await s3.send(new GetBucketAclCommand({ Bucket: bucket })); out.acl = { Owner: a.Owner, Grants: a.Grants }; }
    catch { /* acl optional */ }
    return out;
  }

  async revoke(ctx) {
    const { resourceArn, principalArn, accessSource, accessInfo, clients } = ctx;
    const bucket = bucketName(resourceArn);
    const s3 = clients.s3;

    if (!principalArn) {
      // Full bucket lockdown
      const actions = [];
      const existing = await getPolicy(bucket, accessInfo, s3);
      if (existing) { await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket })); actions.push('DeleteBucketPolicy'); }
      await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: BLOCK_ALL })); actions.push('PutPublicAccessBlock');
      await s3.send(new PutBucketAclCommand({ Bucket: bucket, ACL: 'private' })); actions.push('PutBucketAcl:private');
      return { applied: true, actions };
    }

    // Per-principal, scoped to this bucket
    if (accessSource === 'ACL') {
      const acl = accessInfo?.acl || (await this.snapshot(ctx)).acl;
      if (!acl?.Grants) return { applied: false, actions: [], note: 'No ACL grants to remove' };
      const grants = acl.Grants.filter((g) => !(g.Grantee?.ID === acl.Owner?.ID) ? (g.Grantee?.ID !== principalArn && g.Grantee?.URI !== principalArn) : true);
      await s3.send(new PutBucketAclCommand({ Bucket: bucket, AccessControlPolicy: { Owner: acl.Owner, Grants: grants } }));
      return { applied: true, actions: ['PutBucketAcl:removeGrant'] };
    }

    const policy = await getPolicy(bucket, accessInfo, s3);
    if (accessSource === 'BUCKET_POLICY' && policy) {
      const next = stripPrincipal(policy, principalArn);
      const action = await putOrDeletePolicy(bucket, next, s3);
      return { applied: true, actions: [action] };
    }

    // IAM_POLICY / IAM_GROUP / HISTORICAL / unknown -> scoped explicit Deny (doesn't touch user IAM)
    const denied = withExplicitDeny(policy, bucket, principalArn, ['s3:*']);
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(denied) }));
    return { applied: true, actions: [`PutBucketPolicy:explicitDeny(${principalArn})`] };
  }

  async modify(ctx) {
    const { resourceArn, principalArn, accessSource, accessInfo, changes, clients } = ctx;
    const bucket = bucketName(resourceArn);
    const s3 = clients.s3;
    const c = changes || {};
    const actions = [];

    // Resource-level partial revoke: remove policy statements / ACL grants / enable PAB.
    if (c.removeStatements?.length || c.removeAclGrants?.length || c.enablePublicAccessBlock) {
      if (c.removeStatements?.length) {
        const policy = await getPolicy(bucket, accessInfo, s3);
        if (policy) {
          const remaining = (policy.Statement || []).filter((s) => !c.removeStatements.includes(s.Sid));
          actions.push(await putOrDeletePolicy(bucket, { ...policy, Statement: remaining }, s3));
        }
      }
      if (c.removeAclGrants?.length) {
        const acl = accessInfo?.acl || (await this.snapshot(ctx)).acl;
        if (acl?.Grants) {
          const grants = acl.Grants.filter((g) => {
            if (g.Grantee?.ID && g.Grantee.ID === acl.Owner?.ID) return true; // preserve owner
            const id = g.Grantee?.URI || g.Grantee?.ID || '';
            return !c.removeAclGrants.includes(id);
          });
          await s3.send(new PutBucketAclCommand({ Bucket: bucket, AccessControlPolicy: { Owner: acl.Owner, Grants: grants } }));
          actions.push('PutBucketAcl:removeGrants');
        }
      }
      if (c.enablePublicAccessBlock) {
        await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: BLOCK_ALL }));
        actions.push('PutPublicAccessBlock');
      }
      return { applied: actions.length > 0, actions };
    }

    // Per-principal action removal.
    const removeActions = c.removeActions || [];
    if (!principalArn || removeActions.length === 0) {
      throw new TicketRequiredError('S3 modify requires resource-level changes (removeStatements/removeAclGrants/enablePublicAccessBlock) or principal + removeActions');
    }
    const policy = await getPolicy(bucket, accessInfo, s3);
    if (accessSource === 'BUCKET_POLICY' && policy) {
      const next = stripActions(policy, principalArn, removeActions);
      return { applied: true, actions: [`${await putOrDeletePolicy(bucket, next, s3)}:removeActions`] };
    }
    // Access via IAM/ACL -> scoped explicit Deny of just those actions on this bucket
    const denied = withExplicitDeny(policy, bucket, principalArn, removeActions);
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(denied) }));
    return { applied: true, actions: [`PutBucketPolicy:denyActions(${removeActions.join(',')})`] };
  }

  async rollback(ctx, snapshot) {
    const bucket = bucketName(ctx.resourceArn);
    const s3 = ctx.clients.s3;
    const actions = [];
    actions.push(await putOrDeletePolicy(bucket, snapshot.bucketPolicy, s3));
    if (snapshot.publicAccessBlock) {
      await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: snapshot.publicAccessBlock }));
      actions.push('PutPublicAccessBlock');
    }
    if (snapshot.acl?.Owner) {
      await s3.send(new PutBucketAclCommand({ Bucket: bucket, AccessControlPolicy: { Owner: snapshot.acl.Owner, Grants: snapshot.acl.Grants || [] } }));
      actions.push('PutBucketAcl:restore');
    }
    return { applied: true, actions };
  }
}
