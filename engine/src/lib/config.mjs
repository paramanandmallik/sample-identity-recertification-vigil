/**
 * Engine configuration. Sourced entirely from environment (and STS at runtime).
 * No hardcoded account IDs or resource names — this is what makes the engine portable
 * across customer accounts.
 * @module lib/config
 */

/** Static config resolved from environment at module load. */
export const config = Object.freeze({
  tableName: process.env.TABLE_NAME || 'RecertEngineTable',
  enforcementQueueUrl: process.env.ENFORCEMENT_QUEUE_URL || '',
  evidenceBucket: process.env.EVIDENCE_BUCKET || '',
  sesSenderEmail: process.env.SES_SENDER_EMAIL || '',
  uiBaseUrl: (process.env.UI_BASE_URL || '').replace(/\/$/, ''),
  recertDeadlineDays: parseInt(process.env.RECERT_DEADLINE_DAYS || '14', 10),
  crossAccountRoleName: process.env.CROSS_ACCOUNT_ROLE_NAME || 'VIGILCrossAccountRole',
  region: process.env.AWS_REGION || 'us-east-1',
});

let cachedAccountId = process.env.MANAGEMENT_ACCOUNT_ID || null;

/**
 * Resolve the account ID this engine runs in. Uses the env override if present,
 * otherwise calls STS GetCallerIdentity once and caches for the execution lifetime.
 * @returns {Promise<string>}
 */
export const getAccountId = async () => {
  if (cachedAccountId) return cachedAccountId;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({});
  const id = await sts.send(new GetCallerIdentityCommand({}));
  cachedAccountId = id.Account;
  return cachedAccountId;
};

/** Reset the cached account id (tests only). */
export const __resetAccountIdCache = () => { cachedAccountId = process.env.MANAGEMENT_ACCOUNT_ID || null; };
