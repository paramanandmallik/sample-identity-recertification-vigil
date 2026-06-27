/**
 * Base resource connector — the pluggable contract every resource type implements.
 * The enforcer never touches AWS APIs directly; it calls connectors. Add a new
 * resource type by implementing this interface and registering it.
 * @module connectors/base-connector
 */

/**
 * @typedef {Object} EnforcementContext
 * @property {string} resourceArn   - Target resource ARN.
 * @property {string} resourceType  - e.g. 's3:bucket', 'iam:user'.
 * @property {string} [principalArn] - Specific principal to act on (per-principal decisions).
 * @property {string} [accessSource] - How the principal has access: BUCKET_POLICY|IAM_POLICY|IAM_GROUP|ACL.
 * @property {Object} [accessInfo]   - Current access config captured at discovery (avoids re-fetch).
 * @property {Object} [changes]      - For MODIFY: structured change set, e.g. { remove: ['s3:PutObject'] }.
 * @property {Object} clients        - AWS SDK clients scoped to the resource's account.
 * @property {string} accountId      - Account the resource lives in.
 */

/**
 * @typedef {Object} EnforcementResult
 * @property {boolean} applied       - True if a real change was made.
 * @property {string[]} actions      - Human-readable actions taken (audited).
 * @property {string} [note]         - Optional explanation (e.g. why nothing was applied).
 */

/** Thrown when a connector cannot safely automate a change and a ticket is required. */
export class TicketRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TicketRequiredError';
    this.details = details;
  }
}

export class BaseConnector {
  /** @returns {string[]} resourceType identifiers this connector handles. */
  static get resourceTypes() { return []; }

  /** @returns {{ revoke: boolean, modify: boolean, perPrincipal: boolean, rollback: boolean }} */
  static get capabilities() {
    return { revoke: false, modify: false, perPrincipal: false, rollback: false };
  }

  /**
   * Capture the resource's current access configuration (before-state) for evidence + rollback.
   * @param {EnforcementContext} ctx
   * @returns {Promise<Object>} serializable before-state
   */
  async snapshot(ctx) { // eslint-disable-line no-unused-vars
    throw new Error('NotImplemented: snapshot()');
  }

  /**
   * Fully or per-principal revoke access to the resource (scoped to this resource only).
   * @param {EnforcementContext} ctx
   * @returns {Promise<EnforcementResult>}
   */
  async revoke(ctx) { // eslint-disable-line no-unused-vars
    throw new Error('NotImplemented: revoke()');
  }

  /**
   * Apply a scoped modification (e.g. remove specific permissions) without breaking
   * unrelated access. Throw TicketRequiredError if it cannot be done safely.
   * @param {EnforcementContext} ctx
   * @returns {Promise<EnforcementResult>}
   */
  async modify(ctx) { // eslint-disable-line no-unused-vars
    throw new Error('NotImplemented: modify()');
  }

  /**
   * Restore the resource to a previously captured snapshot.
   * @param {EnforcementContext} ctx
   * @param {Object} snapshot - before-state produced by snapshot()
   * @returns {Promise<EnforcementResult>}
   */
  async rollback(ctx, snapshot) { // eslint-disable-line no-unused-vars
    throw new Error('NotImplemented: rollback()');
  }
}
