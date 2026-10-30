import type { Knex } from 'knex';

/**
 * Platform-default mail templates (tenant_id NULL). Tenants may override any
 * template by inserting a row with their tenant_id; the newest version wins.
 * Placeholders use {{name}} and are HTML-escaped at render time.
 */
export const DEFAULT_MAIL_TEMPLATES: ReadonlyArray<{ code: string; subject: string; html: string; text: string }> = [
  {
    code: 'ACCOUNT_ACTIVATION',
    subject: '{{tenantName}} ExamOS: activate your account',
    html: '<p>Dear {{fullName}},</p><p>Your examination account is ready. Activate it within {{expiresInHours}} hours using the link below.</p><p><a href="{{activationUrl}}">Activate account</a></p><p>If you did not expect this message, ignore it.</p><p>{{tenantName}} Examination Cell</p>',
    text: 'Dear {{fullName}},\n\nYour examination account is ready. Activate it within {{expiresInHours}} hours: {{activationUrl}}\n\n{{tenantName}} Examination Cell',
  },
  {
    code: 'REHEARSAL_REMINDER',
    subject: '{{examTitle}}: run your device rehearsal before {{rehearsalDeadline}}',
    html: '<p>Dear {{fullName}},</p><p>Your exam <strong>{{examTitle}}</strong> is scheduled for {{examStartLocal}}. Please complete the device rehearsal at <a href="{{portalUrl}}">{{portalUrl}}</a> before {{rehearsalDeadline}}.</p><p>A failed rehearsal is never counted against you; it tells support what to fix.</p>',
    text: 'Dear {{fullName}},\n\nYour exam {{examTitle}} is scheduled for {{examStartLocal}}. Complete the device rehearsal at {{portalUrl}} before {{rehearsalDeadline}}.',
  },
  {
    code: 'PREFLIGHT_REMINDER',
    subject: '{{examTitle}} today: 15-minute readiness check opens at {{precheckOpensLocal}}',
    html: '<p>Dear {{fullName}},</p><p>Sign in at <a href="{{portalUrl}}">{{portalUrl}}</a> when the readiness check opens at {{precheckOpensLocal}}. The exam timer starts only after you are admitted.</p>',
    text: 'Dear {{fullName}},\n\nSign in at {{portalUrl}} when the readiness check opens at {{precheckOpensLocal}}. The exam timer starts only after you are admitted.',
  },
  {
    code: 'ADMISSION_RECEIPT',
    subject: '{{examTitle}}: admission receipt {{receiptId}}',
    html: '<p>Dear {{fullName}},</p><p>You were admitted to <strong>{{examTitle}}</strong> at {{admittedAtLocal}}. Receipt {{receiptId}}.</p>',
    text: 'Dear {{fullName}},\n\nYou were admitted to {{examTitle}} at {{admittedAtLocal}}. Receipt {{receiptId}}.',
  },
  {
    code: 'SUSPENSION_ALERT',
    subject: '[ACTION] Attempt {{attemptId}} suspended ({{reason}})',
    html: '<p>Attempt <strong>{{attemptId}}</strong> for {{examTitle}} was suspended at {{suspendedAtLocal}} ({{reason}}). Open the proctor console: <a href="{{consoleUrl}}">{{consoleUrl}}</a></p>',
    text: 'Attempt {{attemptId}} for {{examTitle}} was suspended at {{suspendedAtLocal}} ({{reason}}). Console: {{consoleUrl}}',
  },
  {
    code: 'TECHNICAL_HOLD_TICKET',
    subject: '[SUPPORT] Technical hold on attempt {{attemptId}}',
    html: '<p>A technical hold was placed on attempt <strong>{{attemptId}}</strong> ({{examTitle}}) at {{heldAtLocal}}: {{reason}}.</p>',
    text: 'A technical hold was placed on attempt {{attemptId}} ({{examTitle}}) at {{heldAtLocal}}: {{reason}}.',
  },
  {
    code: 'RESULT_PUBLISHED',
    subject: '{{examTitle}}: your result is available',
    html: '<p>Dear {{fullName}},</p><p>Your result for <strong>{{examTitle}}</strong> has been published. View it in the portal: <a href="{{portalUrl}}">{{portalUrl}}</a>.</p>',
    text: 'Dear {{fullName}},\n\nYour result for {{examTitle}} has been published. View it in the portal: {{portalUrl}}',
  },
  {
    code: 'CANDIDATE_HOLD_NOTICE',
    subject: '{{examTitle}}: your result is on hold pending review',
    html: '<p>Dear {{fullName}},</p><p>Your result for <strong>{{examTitle}}</strong> is on hold: {{holdReason}}. The Examination Cell will contact you; you may respond through the portal: <a href="{{portalUrl}}">{{portalUrl}}</a>.</p>',
    text: 'Dear {{fullName}},\n\nYour result for {{examTitle}} is on hold: {{holdReason}}. Respond through the portal: {{portalUrl}}',
  },
  {
    code: 'SECURITY_ALERT',
    subject: '[SECURITY] Export blocked during {{examTitle}} ({{examStatus}})',
    html: '<p>{{actorName}} ({{actorEmail}}) attempted to export <strong>{{what}}</strong> for {{examTitle}} at {{at}} while the exam was {{examStatus}}. The request was refused and logged.</p>',
    text: '{{actorName}} ({{actorEmail}}) attempted to export {{what}} for {{examTitle}} at {{at}} while the exam was {{examStatus}}. The request was refused and logged.',
  },
  {
    code: 'EXAM_CELL_DIGEST',
    subject: '{{examTitle}}: {{ready}} ready, {{needsReview}} need review, {{onHold}} on hold',
    html: '<p>{{examTitle}} candidate status at {{generatedAtLocal}}: <strong>{{ready}}</strong> ready, <strong>{{needsReview}}</strong> need review, <strong>{{onHold}}</strong> on hold.</p>',
    text: '{{examTitle}} candidate status at {{generatedAtLocal}}: {{ready}} ready, {{needsReview}} need review, {{onHold}} on hold.',
  },
  {
    code: 'REVALUATION_DECISION',
    subject: 'Revaluation Decision for {{examTitle}}: {{decision}}',
    html: '<p>Dear {{fullName}},</p><p>Your revaluation request for <strong>{{examTitle}}</strong> has been <strong>{{decision}}</strong>.</p><p>{{decisionNote}}</p><p>View your updated status on the student portal: <a href="{{portalUrl}}">{{portalUrl}}</a></p>',
    text: 'Dear {{fullName}},\n\nYour revaluation request for {{examTitle}} has been {{decision}}.\n\n{{decisionNote}}\n\nView your updated status: {{portalUrl}}',
  },
];

export async function seedPlatform(db: Knex): Promise<void> {
  for (const t of DEFAULT_MAIL_TEMPLATES) {
    const exists = await db('mail_templates').whereNull('tenant_id').where({ code: t.code, version: 1, locale: 'en' }).first();
    if (!exists) {
      await db('mail_templates').insert({ tenant_id: null, code: t.code, version: 1, locale: 'en', subject: t.subject, html: t.html, text: t.text });
    }
  }
}
