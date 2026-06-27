/**
 * Deterministic access enumeration for S3 buckets: derives the principals with access
 * from the bucket policy (Allow statements) and ACL grants. This is the reliable,
 * no-guess portion of "who has access". Pluggable: richer IAM policy-simulation /
 * CloudTrail-usage enrichment can be layered on top of these entries later.
 * @module discovery/access
 */

const principalType = (arn) => {
  if (!arn) return 'UNKNOWN';
  if (arn.includes(':user/')) return 'IAM_USER';
  if (arn.includes(':role/') || arn.includes(':assumed-role/')) return 'IAM_ROLE';
  if (arn.endsWith('.amazonaws.com')) return 'AWS_SERVICE';
  if (/^(arn:aws:iam::\d{12}:root|\d{12})$/.test(arn)) return 'AWS_ACCOUNT';
  return 'IAM_USER';
};
const nameOf = (arn) => (arn || '').split(/[/:]/).pop() || arn;
const asArray = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]));

/**
 * @param {object|null} bucketPolicy
 * @param {{Owner?:object, Grants?:Array}|null} acl
 * @returns {Array<{principalArn:string, principalName:string, principalType:string, accessSource:string, permissions:string[]}>}
 */
export const buildS3AccessEntries = (bucketPolicy, acl) => {
  const map = new Map();

  for (const st of bucketPolicy?.Statement || []) {
    if (st.Effect !== 'Allow') continue;
    const principals = st.Principal?.AWS ? asArray(st.Principal.AWS)
      : (st.Principal?.Service ? asArray(st.Principal.Service) : (typeof st.Principal === 'string' ? [st.Principal] : []));
    const actions = asArray(st.Action);
    for (const p of principals) {
      if (p === '*') continue;
      const cur = map.get(p) || { principalArn: p, principalName: nameOf(p), principalType: principalType(p), accessSource: 'BUCKET_POLICY', permissions: [] };
      cur.permissions = [...new Set([...cur.permissions, ...actions])];
      map.set(p, cur);
    }
  }

  for (const g of acl?.Grants || []) {
    if (g.Grantee?.ID && g.Grantee.ID === acl.Owner?.ID) continue; // skip owner grant
    const id = g.Grantee?.ID || g.Grantee?.URI;
    if (!id) continue;
    const cur = map.get(id) || { principalArn: id, principalName: nameOf(id), principalType: principalType(id), accessSource: 'ACL', permissions: [] };
    cur.permissions = [...new Set([...cur.permissions, `ACL:${g.Permission}`])];
    map.set(id, cur);
  }

  return [...map.values()];
};
