/**
 * Core data model for the recertification engine: single-table entity shapes,
 * DynamoDB key builders, and the decision / enforcement / review state machines.
 * @module core/models
 */

/** DynamoDB entity discriminators. */
export const ENTITY = Object.freeze({
  CYCLE: 'CYCLE',
  REVIEW_ITEM: 'REVIEW_ITEM',
  DECISION: 'DECISION',
  SNAPSHOT: 'SNAPSHOT',
  EVIDENCE: 'EVIDENCE',
  TICKET: 'TICKET',
  OWNER_OVERRIDE: 'OWNER_OVERRIDE',
});

/** Owner decision verbs (what the reviewer chose). */
export const DECISION = Object.freeze({
  CERTIFY: 'CERTIFY',
  MODIFY: 'MODIFY',
  REVOKE: 'REVOKE',
});

/** Enforcement lifecycle (what the engine did about it). */
export const ENFORCEMENT = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED', // certify - nothing to change
  PENDING: 'PENDING', // queued
  IN_PROGRESS: 'IN_PROGRESS', // enforcer running
  ENFORCED: 'ENFORCED', // change applied + verified
  FAILED: 'FAILED', // exhausted retries; ticket raised
  TICKETED: 'TICKETED', // unsupported/unsafe to automate; manual ticket
});

/** Review item status. */
export const REVIEW = Object.freeze({
  PENDING: 'PENDING',
  CERTIFIED: 'CERTIFIED',
  MODIFIED: 'MODIFIED',
  REVOKED: 'REVOKED',
  PARTIAL: 'PARTIAL', // some principals decided
  ESCALATED: 'ESCALATED',
});

const PK = Object.freeze({
  CYCLE: (cycleId) => `CYCLE#${cycleId}`,
  OWNER: (email) => `OWNER#${email}`,
  RESOURCE: (arn) => `RESOURCE#${arn}`,
  DECISION: (decisionId) => `DECISION#${decisionId}`,
  TYPE: (t) => `TYPE#${t}`,
});

/**
 * Key builders. Single-table design with GSI1 for type/cycle fan-out queries.
 * - Cycle summary:   PK=CYCLE#<id>            SK=SUMMARY
 * - Review item:     PK=OWNER#<email>         SK=REVIEW#<cycleId>#<arn>
 * - Decision:        PK=DECISION#<decisionId> SK=META
 * - Snapshot:        PK=RESOURCE#<arn>        SK=SNAPSHOT#<ts>
 * - Evidence:        PK=RESOURCE#<arn>        SK=EVIDENCE#<ts>
 */
export const keys = Object.freeze({
  cycleSummary: (cycleId) => ({ PK: PK.CYCLE(cycleId), SK: 'SUMMARY' }),
  reviewItem: (ownerEmail, cycleId, arn) => ({ PK: PK.OWNER(ownerEmail), SK: `REVIEW#${cycleId}#${arn}` }),
  reviewItemPrefix: (ownerEmail, cycleId) => ({ PK: PK.OWNER(ownerEmail), SKPrefix: `REVIEW#${cycleId}` }),
  decision: (decisionId) => ({ PK: PK.DECISION(decisionId), SK: 'META' }),
  snapshot: (arn, ts) => ({ PK: PK.RESOURCE(arn), SK: `SNAPSHOT#${ts}` }),
  snapshotPrefix: (arn) => ({ PK: PK.RESOURCE(arn), SKPrefix: 'SNAPSHOT#' }),
  evidence: (arn, ts) => ({ PK: PK.RESOURCE(arn), SK: `EVIDENCE#${ts}` }),
  evidencePrefix: (arn) => ({ PK: PK.RESOURCE(arn), SKPrefix: 'EVIDENCE#' }),
  // GSI1 fan-out
  gsiReviewByCycle: (cycleId, status) => ({ GSI1PK: PK.TYPE(ENTITY.REVIEW_ITEM), GSI1SK: `${cycleId}#${status}` }),
  gsiDecisionByCycle: (cycleId, ts) => ({ GSI1PK: PK.TYPE(ENTITY.DECISION), GSI1SK: `${cycleId}#${ts}` }),
});

/** Map an owner decision verb to its initial enforcement status. */
export const initialEnforcement = (decision) =>
  decision === DECISION.CERTIFY ? ENFORCEMENT.NOT_REQUIRED : ENFORCEMENT.PENDING;

/** Map an owner decision verb to the resulting review-item status. */
export const reviewStatusFor = (decision) => ({
  [DECISION.CERTIFY]: REVIEW.CERTIFIED,
  [DECISION.MODIFY]: REVIEW.MODIFIED,
  [DECISION.REVOKE]: REVIEW.REVOKED,
}[decision]);

/** Validate a decision verb. */
export const isValidDecision = (d) => Object.values(DECISION).includes(d);

/** Deterministic decision id: stable per (cycle, resource, principal) for idempotency. */
export const decisionId = (cycleId, resourceArn, principalArn = '_resource_') =>
  `${cycleId}::${resourceArn}::${principalArn}`;
