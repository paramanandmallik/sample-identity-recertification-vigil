/**
 * EC2 instance connector. "Access" to an instance is governed by its IAM instance profile
 * (what the instance can do in AWS) and its security groups (what can reach it). Enforcement:
 *  - revoke (full): disassociate the IAM instance profile and move the instance to a
 *    no-inbound "quarantine" security group.
 *  - modify: detach the instance profile and/or remove selected security groups.
 *  - snapshot + rollback (re-associate the profile, restore the original security groups).
 * Scoped to a single instance.
 * @module connectors/ec2-connector
 */

import {
  DescribeInstancesCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DisassociateIamInstanceProfileCommand,
  AssociateIamInstanceProfileCommand,
  ModifyInstanceAttributeCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
} from '@aws-sdk/client-ec2';
import { BaseConnector, TicketRequiredError } from './base-connector.mjs';

const QUARANTINE = 'recert-quarantine';
const instanceId = (arn) => (arn?.startsWith('arn:') ? arn.split('/').pop() : arn) || arn;

const ensureQuarantineSg = async (ec2, vpcId) => {
  if (!vpcId) throw new TicketRequiredError('Instance VPC unknown; cannot apply quarantine security group');
  const found = await ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: 'group-name', Values: [QUARANTINE] }, { Name: 'vpc-id', Values: [vpcId] }],
  }));
  if (found.SecurityGroups?.[0]) return found.SecurityGroups[0].GroupId;
  const created = await ec2.send(new CreateSecurityGroupCommand({
    GroupName: QUARANTINE, Description: 'Recertification quarantine — no inbound access', VpcId: vpcId,
  }));
  return created.GroupId; // new SGs have no inbound rules by default
};

const fetchState = async (id, ec2) => {
  const di = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
  const inst = di.Reservations?.[0]?.Instances?.[0] || {};
  const assoc = await ec2.send(new DescribeIamInstanceProfileAssociationsCommand({
    Filters: [{ Name: 'instance-id', Values: [id] }],
  }));
  const a = (assoc.IamInstanceProfileAssociations || []).find((x) => x.State === 'associated' || x.State === 'associating')
    || (assoc.IamInstanceProfileAssociations || [])[0];
  return {
    securityGroups: (inst.SecurityGroups || []).map((g) => g.GroupId),
    vpcId: inst.VpcId,
    iamInstanceProfile: a ? { associationId: a.AssociationId, arn: a.IamInstanceProfile?.Arn } : null,
  };
};

export class Ec2Connector extends BaseConnector {
  static get resourceTypes() { return ['ec2:instance']; }
  static get capabilities() { return { revoke: true, modify: true, perPrincipal: false, rollback: true }; }

  async snapshot(ctx) {
    if (ctx.accessInfo?.securityGroups) return ctx.accessInfo;
    return fetchState(instanceId(ctx.resourceArn), ctx.clients.ec2);
  }

  async revoke(ctx) {
    const id = instanceId(ctx.resourceArn);
    const ec2 = ctx.clients.ec2;
    const state = ctx.accessInfo?.securityGroups ? ctx.accessInfo : await fetchState(id, ec2);
    const actions = [];
    if (state.iamInstanceProfile?.associationId) {
      await ec2.send(new DisassociateIamInstanceProfileCommand({ AssociationId: state.iamInstanceProfile.associationId }));
      actions.push('DisassociateIamInstanceProfile');
    }
    const qsg = await ensureQuarantineSg(ec2, state.vpcId);
    await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, Groups: [qsg] }));
    actions.push(`ModifyInstanceAttribute:Groups=[${qsg}]`);
    return { applied: true, actions };
  }

  async modify(ctx) {
    const id = instanceId(ctx.resourceArn);
    const ec2 = ctx.clients.ec2;
    const c = ctx.changes || {};
    const removeSgs = c.removeSecurityGroups || [];
    if (removeSgs.length === 0 && !c.detachInstanceProfile) {
      throw new TicketRequiredError('EC2 modify requires removeSecurityGroups or detachInstanceProfile');
    }
    const state = ctx.accessInfo?.securityGroups ? ctx.accessInfo : await fetchState(id, ec2);
    const actions = [];
    if (c.detachInstanceProfile && state.iamInstanceProfile?.associationId) {
      await ec2.send(new DisassociateIamInstanceProfileCommand({ AssociationId: state.iamInstanceProfile.associationId }));
      actions.push('DisassociateIamInstanceProfile');
    }
    if (removeSgs.length > 0) {
      const remaining = (state.securityGroups || []).filter((g) => !removeSgs.includes(g));
      const groups = remaining.length > 0 ? remaining : [await ensureQuarantineSg(ec2, state.vpcId)];
      await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, Groups: groups }));
      actions.push(`ModifyInstanceAttribute:Groups=[${groups.join(',')}]`);
    }
    return { applied: true, actions };
  }

  async rollback(ctx, snapshot) {
    const id = instanceId(ctx.resourceArn);
    const ec2 = ctx.clients.ec2;
    const actions = [];
    if (snapshot.securityGroups?.length) {
      await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, Groups: snapshot.securityGroups }));
      actions.push(`ModifyInstanceAttribute:Groups=[${snapshot.securityGroups.join(',')}]`);
    }
    if (snapshot.iamInstanceProfile?.arn) {
      await ec2.send(new AssociateIamInstanceProfileCommand({ InstanceId: id, IamInstanceProfile: { Arn: snapshot.iamInstanceProfile.arn } }));
      actions.push('AssociateIamInstanceProfile');
    }
    return { applied: true, actions };
  }
}
