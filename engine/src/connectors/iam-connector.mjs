/**
 * IAM user connector. Used when the *resource being recertified is an IAM user*.
 *  - revoke (full): disable the user — detach managed policies, remove from groups,
 *    deactivate active keys, delete login profile. (Appropriate: the user is the resource.)
 *  - modify: remove only the selected policies / groups / access keys (scoped).
 *  - snapshot + rollback for full reversibility (login profile password cannot be restored).
 *
 * NOTE: per-principal access to *other* resources (e.g. an IAM user's access to an S3 bucket)
 * is handled by that resource's connector via a scoped Deny — never by broadly mutating the
 * user here. This connector only acts when resourceType === 'iam:user'.
 * @module connectors/iam-connector
 */

import {
  ListAttachedUserPoliciesCommand, DetachUserPolicyCommand, AttachUserPolicyCommand,
  ListGroupsForUserCommand, RemoveUserFromGroupCommand, AddUserToGroupCommand,
  ListAccessKeysCommand, UpdateAccessKeyCommand,
  GetLoginProfileCommand, DeleteLoginProfileCommand,
} from '@aws-sdk/client-iam';
import { BaseConnector, TicketRequiredError } from './base-connector.mjs';

const userName = (arn) => (arn?.startsWith('arn:') ? arn.split('/').pop() : arn) || arn;

const fetchState = async (user, iam) => {
  const [pol, grp, keys] = await Promise.all([
    iam.send(new ListAttachedUserPoliciesCommand({ UserName: user })),
    iam.send(new ListGroupsForUserCommand({ UserName: user })),
    iam.send(new ListAccessKeysCommand({ UserName: user })),
  ]);
  let hasLoginProfile = false;
  try { await iam.send(new GetLoginProfileCommand({ UserName: user })); hasLoginProfile = true; }
  catch (e) { if (e.name !== 'NoSuchEntity' && e.name !== 'NoSuchEntityException') throw e; }
  return {
    attachedPolicies: (pol.AttachedPolicies || []).map((p) => ({ PolicyArn: p.PolicyArn, PolicyName: p.PolicyName })),
    groups: (grp.Groups || []).map((g) => ({ GroupName: g.GroupName })),
    accessKeys: (keys.AccessKeyMetadata || []).map((k) => ({ AccessKeyId: k.AccessKeyId, Status: k.Status })),
    hasLoginProfile,
  };
};

export class IamConnector extends BaseConnector {
  static get resourceTypes() { return ['iam:user']; }
  static get capabilities() { return { revoke: true, modify: true, perPrincipal: false, rollback: true }; }

  async snapshot(ctx) {
    if (ctx.accessInfo?.attachedPolicies) return ctx.accessInfo;
    return fetchState(userName(ctx.resourceArn), ctx.clients.iam);
  }

  async revoke(ctx) {
    const user = userName(ctx.resourceArn);
    const iam = ctx.clients.iam;
    const state = ctx.accessInfo?.attachedPolicies ? ctx.accessInfo : await fetchState(user, iam);
    const actions = [];

    for (const p of state.attachedPolicies || []) {
      await iam.send(new DetachUserPolicyCommand({ UserName: user, PolicyArn: p.PolicyArn }));
      actions.push(`DetachUserPolicy:${p.PolicyArn}`);
    }
    for (const g of state.groups || []) {
      await iam.send(new RemoveUserFromGroupCommand({ UserName: user, GroupName: g.GroupName }));
      actions.push(`RemoveUserFromGroup:${g.GroupName}`);
    }
    for (const k of state.accessKeys || []) {
      if (k.Status === 'Active') {
        await iam.send(new UpdateAccessKeyCommand({ UserName: user, AccessKeyId: k.AccessKeyId, Status: 'Inactive' }));
        actions.push(`DeactivateAccessKey:${k.AccessKeyId}`);
      }
    }
    if (state.hasLoginProfile) {
      try { await iam.send(new DeleteLoginProfileCommand({ UserName: user })); actions.push('DeleteLoginProfile'); }
      catch (e) { if (e.name !== 'NoSuchEntity' && e.name !== 'NoSuchEntityException') throw e; }
    }
    return { applied: actions.length > 0, actions, note: actions.length === 0 ? 'User already had no access' : undefined };
  }

  async modify(ctx) {
    const user = userName(ctx.resourceArn);
    const iam = ctx.clients.iam;
    const c = ctx.changes || {};
    const removePolicies = c.removePolicies || [];
    const removeGroups = c.removeGroups || [];
    const removeAccessKeys = c.removeAccessKeys || [];
    if (removePolicies.length + removeGroups.length + removeAccessKeys.length === 0) {
      throw new TicketRequiredError('IAM modify requires removePolicies/removeGroups/removeAccessKeys');
    }
    const actions = [];
    for (const arn of removePolicies) {
      await iam.send(new DetachUserPolicyCommand({ UserName: user, PolicyArn: arn }));
      actions.push(`DetachUserPolicy:${arn}`);
    }
    for (const g of removeGroups) {
      await iam.send(new RemoveUserFromGroupCommand({ UserName: user, GroupName: g }));
      actions.push(`RemoveUserFromGroup:${g}`);
    }
    for (const k of removeAccessKeys) {
      await iam.send(new UpdateAccessKeyCommand({ UserName: user, AccessKeyId: k, Status: 'Inactive' }));
      actions.push(`DeactivateAccessKey:${k}`);
    }
    return { applied: true, actions };
  }

  async rollback(ctx, snapshot) {
    const user = userName(ctx.resourceArn);
    const iam = ctx.clients.iam;
    const actions = [];
    for (const p of snapshot.attachedPolicies || []) {
      await iam.send(new AttachUserPolicyCommand({ UserName: user, PolicyArn: p.PolicyArn }));
      actions.push(`AttachUserPolicy:${p.PolicyArn}`);
    }
    for (const g of snapshot.groups || []) {
      await iam.send(new AddUserToGroupCommand({ UserName: user, GroupName: g.GroupName }));
      actions.push(`AddUserToGroup:${g.GroupName}`);
    }
    for (const k of snapshot.accessKeys || []) {
      if (k.Status === 'Active') {
        await iam.send(new UpdateAccessKeyCommand({ UserName: user, AccessKeyId: k.AccessKeyId, Status: 'Active' }));
        actions.push(`ReactivateAccessKey:${k.AccessKeyId}`);
      }
    }
    return { applied: true, actions, note: snapshot.hasLoginProfile ? 'Login profile cannot be auto-restored (password reset required)' : undefined };
  }
}
