/**
 * recert-enforcer Lambda. SQS consumer that drives enforcement for each queued decision.
 * Uses partial batch responses so only failed messages are retried / dead-lettered.
 * Configure the event source with ReportBatchItemFailures = true.
 * @module enforcer/handler
 */

import { enforceDecision } from '../core/enforcement.mjs';
import { log } from '../lib/http.mjs';

export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records || []) {
    let decisionId;
    try {
      const body = JSON.parse(record.body || '{}');
      decisionId = body.decisionId;
      if (!decisionId) { log('error', 'ENFORCER_MISSING_DECISION_ID', { messageId: record.messageId }); continue; }
      await enforceDecision(decisionId);
    } catch (err) {
      log('error', 'ENFORCER_RECORD_FAILED', { messageId: record.messageId, decisionId, message: err.message });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
