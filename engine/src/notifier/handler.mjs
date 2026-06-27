/**
 * recert-notifier Lambda. Sends owner-facing recertification emails via SES.
 * Actions: INITIAL | REMINDER | ESCALATION | CONFIRMATION. Deep links use UI_BASE_URL
 * (config-driven — no hardcoded localhost).
 * @module notifier/handler
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.mjs';
import { ENTITY } from '../core/models.mjs';
import { config } from '../lib/config.mjs';
import { isoString, epochMs } from '../lib/time.mjs';
import { log } from '../lib/http.mjs';

const ses = new SESClient({});

const reviewItemsByCycle = async (cycleId) => {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME, IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TYPE#${ENTITY.REVIEW_ITEM}`, ':sk': cycleId },
  }));
  return r.Items || [];
};

const groupByOwner = (items) => items.reduce((m, it) => {
  (m[it.ownerEmail] = m[it.ownerEmail] || []).push(it); return m;
}, {});

const reviewLink = (cycleId) => `${config.uiBaseUrl || ''}/recert/${cycleId}`;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const resourceTable = (items) => `
  <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">
    <thead><tr style="background:#f2f3f3;">
      <th style="text-align:left;padding:8px;">Resource</th><th style="text-align:left;padding:8px;">Type</th>
    </tr></thead><tbody>
    ${items.map((i) => `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(i.resourceName)}</td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(i.resourceType)}</td></tr>`).join('')}
    </tbody></table>`;

const templates = {
  INITIAL: (owner, cycleId, items) => ({
    subject: `[ACTION REQUIRED] ${cycleId} access recertification - ${items.length} resource(s)`,
    html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#16191f;">
      <h2 style="color:#0972d3;">${escapeHtml(cycleId)} Access Recertification</h2>
      <p>You own <strong>${items.length}</strong> resource(s) requiring review.</p>
      <p><a href="${reviewLink(cycleId)}" style="background:#0972d3;color:#fff;padding:10px 20px;border-radius:20px;text-decoration:none;">Review now</a></p>
      ${resourceTable(items)}</div>`,
  }),
  REMINDER: (owner, cycleId, items) => ({
    subject: `[REMINDER] ${cycleId} access recertification - ${items.length} pending`,
    html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#16191f;">
      <h2 style="color:#0972d3;">Reminder: ${escapeHtml(cycleId)} recertification</h2>
      <p>You still have <strong>${items.length}</strong> pending review(s).</p>
      <p><a href="${reviewLink(cycleId)}" style="background:#0972d3;color:#fff;padding:10px 20px;border-radius:20px;text-decoration:none;">Complete reviews</a></p></div>`,
  }),
  ESCALATION: (owner, cycleId, items) => ({
    subject: `[ESCALATION] ${cycleId} recertification overdue - ${escapeHtml(owner)}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#16191f;">
      <div style="background:#d91515;color:#fff;padding:10px;text-align:center;font-weight:bold;">DEADLINE PASSED</div>
      <p><strong>${escapeHtml(owner)}</strong> has <strong>${items.length}</strong> unreviewed resource(s).</p>
      <p><a href="${reviewLink(cycleId)}">View details</a></p></div>`,
  }),
};

const sendEmail = async ({ to, subject, html, cycleId, notificationType }) => {
  const now = new Date();
  let status = 'SENT';
  try {
    await ses.send(new SendEmailCommand({
      Source: config.sesSenderEmail,
      Destination: { ToAddresses: [to] },
      Message: { Subject: { Data: subject }, Body: { Html: { Data: html } } },
    }));
  } catch (e) {
    status = e.name === 'MessageRejected' ? 'BOUNCED' : 'FAILED';
    log('error', 'EMAIL_SEND_FAILED', { to, notificationType, message: e.message });
  }
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `OWNER#${to}`, SK: `NOTIFICATION#${cycleId}#${notificationType}#${isoString(now)}`,
      entityType: 'NOTIFICATION',
      cycleId, ownerEmail: to, notificationType, status,
      createdAt: isoString(now), createdAtEpoch: epochMs(now),
    },
  })).catch(() => {});
};

export const handler = async (event) => {
  const action = event.action || 'INITIAL';
  const cycleId = event.cycleId;
  if (!cycleId) { log('error', 'NOTIFIER_MISSING_CYCLE', { event }); return; }

  // Single-resource confirmation (post-enforcement)
  if (action === 'CONFIRMATION') {
    if (!event.ownerEmail) return;
    await sendEmail({
      to: event.ownerEmail, cycleId, notificationType: 'CONFIRMATION',
      subject: `Access change applied - ${escapeHtml(event.resourceArn || '')} (${cycleId})`,
      html: `<div style="font-family:Arial,sans-serif;">Your recertification decision for <strong>${escapeHtml(event.resourceArn || '')}</strong> has been applied.</div>`,
    });
    return;
  }

  const items = await reviewItemsByCycle(cycleId);
  const byOwner = groupByOwner(items);
  const tmpl = templates[action] || templates.INITIAL;

  for (const [owner, ownerItems] of Object.entries(byOwner)) {
    if (!owner) continue;
    const relevant = action === 'INITIAL' ? ownerItems : ownerItems.filter((i) => i.status === 'PENDING');
    if (relevant.length === 0) continue;
    const recipient = action === 'ESCALATION' ? (config.sesSenderEmail || owner) : owner;
    const { subject, html } = tmpl(owner, cycleId, relevant);
    await sendEmail({ to: recipient, subject, html, cycleId, notificationType: action });
  }
  log('info', 'NOTIFIER_COMPLETE', { cycleId, action, owners: Object.keys(byOwner).length });
};
