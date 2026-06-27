/**
 * Builds AWS SDK clients scoped to the account a resource lives in.
 * Uses local execution-role credentials for the management account, and assumes
 * the cross-account role for member accounts. Clients are injected into connectors
 * (ctx.clients) so connector logic stays pure and unit-testable.
 * @module lib/aws-clients
 */

import { S3Client } from '@aws-sdk/client-s3';
import { IAMClient } from '@aws-sdk/client-iam';
import { config, getAccountId } from './config.mjs';

/**
 * @param {string} [accountId] - Account the resource lives in. Defaults to this account.
 * @returns {Promise<{ s3: S3Client, iam: IAMClient, accountId: string }>}
 */
export const buildClients = async (accountId) => {
  const self = await getAccountId();
  const target = accountId || self;

  if (target === self) {
    return { s3: new S3Client({}), iam: new IAMClient({}), accountId: target };
  }

  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({});
  const res = await sts.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${target}:role/${config.crossAccountRoleName}`,
    RoleSessionName: 'recert-enforcer',
    DurationSeconds: 900,
  }));
  const credentials = {
    accessKeyId: res.Credentials.AccessKeyId,
    secretAccessKey: res.Credentials.SecretAccessKey,
    sessionToken: res.Credentials.SessionToken,
  };
  return { s3: new S3Client({ credentials }), iam: new IAMClient({ credentials }), accountId: target };
};
