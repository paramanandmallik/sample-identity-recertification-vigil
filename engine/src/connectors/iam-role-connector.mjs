/**
 * IAM role connector. Used when the recertified resource is an IAM role.
 *  - revoke (full): detach all attached managed policies (the role keeps existing but loses
 *    granted permissions). Scoped to this role only.
 *  - modify: detach only the selected managed policies (changes.removePolicies).
 *  - snapshot + rollback (reattach). Inline policy names are captured for audit but inline
 *    policy bodies are not auto-restored.
 * @module connectors/iam-role-connector
 */

import {
  ListAttachedRolePoliciesCommand, DetachRolePolicyCommand, AttachRolePolicyCommand,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { BaseConnector, TicketRequiredError } from './base-connector.mjs';

const roleName = (arn) => (arn?.startsWith('arn:') ? arn.split('/').pop() : arn) || arn;

const fetchState = async (role, iam) => {
  const [attached, inline] = await Promise.all([
    iam.send(new ListAttachedRolePoliciesCommand({ RoleName: role })),
    iam.send(new ListRolePoliciesCommand({ RoleName: role })),
  ]);
  return {
    attachedPolicies: (attached.AttachedPolicies || []).map((p) => ({ PolicyArn: p.PolicyArn, PolicyName: p.PolicyName })),
    inlinePolicies: inline.PolicyNames || [],
  };
};

export class IamRoleConnector extends BaseConnector {
  static get resourceTypes() { return ['iam:role']; }
  static get capabilities() { return { revoke: true, modify: true, perPrincipal: false, rollback: true }; }

  async snapshot(ctx) {
    if (ctx.accessInfo?.attachedPolicies) return ctx.accessInfo;
    return fetchState(roleName(ctx.resourceArn), ctx.clients.iam);
  }

  async revoke(ctx) {
    const role = roleName(ctx.resourceArn);
    const iam = ctx.clients.iam;
    const state = ctx.accessInfo?.attachedPolicies ? ctx.accessInfo : await fetchState(role, iam);
    const actions = [];
    for (const p of state.attachedPolicies || []) {
      await iam.send(new DetachRolePolicyCommand({ RoleName: role, PolicyArn: p.PolicyArn }));
      actions.push(`DetachRolePolicy:${p.PolicyArn}`);
    }
    return { applied: actions.length > 0, actions, note: actions.length === 0 ? 'Role had no attached managed policies' : (state.inlinePolicies?.length ? `Inline policies left intact: ${state.inlinePolicies.join(',')}` : undefined) };
  }

  async modify(ctx) {
    const role = roleName(ctx.resourceArn);
    const iam = ctx.clients.iam;
    const removePolicies = ctx.changes?.removePolicies || [];
    if (removePolicies.length === 0) throw new TicketRequiredError('IAM role modify requires removePolicies');
    const actions = [];
    for (const arn of removePolicies) {
      await iam.send(new DetachRolePolicyCommand({ RoleName: role, PolicyArn: arn }));
      actions.push(`DetachRolePolicy:${arn}`);
    }
    return { applied: true, actions };
  }

  async rollback(ctx, snapshot) {
    const role = roleName(ctx.resourceArn);
    const iam = ctx.clients.iam;
    const actions = [];
    for (const p of snapshot.attachedPolicies || []) {
      await iam.send(new AttachRolePolicyCommand({ RoleName: role, PolicyArn: p.PolicyArn }));
      actions.push(`AttachRolePolicy:${p.PolicyArn}`);
    }
    return { applied: true, actions, note: snapshot.inlinePolicies?.length ? 'Inline policies not auto-restored' : undefined };
  }
}
