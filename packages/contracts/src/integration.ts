import { z } from 'zod';
import { API_KEY_SCOPES, WEBHOOK_EVENT_TYPES } from './enums.js';

/**
 * Canonical roster schema for the Simple Integration API (review §5).
 * Any ERP maps its own records to these shapes; ExamOS never depends on an
 * ERP-specific field name. `externalId` must be the ERP's immutable person id,
 * never an e-mail address.
 */

const ExternalId = z.string().trim().min(1).max(128);
const Code = z.string().trim().min(1).max(64);
const Email = z.string().trim().toLowerCase().email().max(254);

export const PersonSchema = z.object({
  externalId: ExternalId,
  kind: z.enum(['STUDENT', 'STAFF']),
  fullName: z.string().trim().min(1).max(200),
  email: Email,
  mobile: z.string().trim().min(6).max(20).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).default('ACTIVE'),
  departmentCode: Code.optional(),
  programmeCode: Code.optional(),
  admissionBatch: z.string().trim().max(32).optional(),
  currentSemester: z.number().int().min(1).max(20).optional(),
  section: z.string().trim().max(32).optional(),
  preferredLanguage: z.string().trim().max(16).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type Person = z.infer<typeof PersonSchema>;

export const AcademicUnitSchema = z.object({
  kind: z.enum(['DEPARTMENT', 'PROGRAMME']),
  code: Code,
  name: z.string().trim().min(1).max(200),
  parentCode: Code.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
export type AcademicUnit = z.infer<typeof AcademicUnitSchema>;

export const CourseSchema = z.object({
  code: Code,
  name: z.string().trim().min(1).max(200),
  departmentCode: Code,
  credits: z.number().min(0).max(40).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
export type Course = z.infer<typeof CourseSchema>;

export const EnrollmentSchema = z.object({
  studentExternalId: ExternalId,
  courseCode: Code,
  academicYear: z.string().regex(/^\d{4}-\d{2,4}$/, 'academicYear like 2026-27'),
  term: z.string().trim().min(1).max(32),
  section: z.string().trim().max(32).optional(),
  eligibilityStatus: z.enum(['ELIGIBLE', 'INELIGIBLE', 'DETAINED', 'PENDING']).default('ELIGIBLE'),
});
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export const MAX_BATCH_ROWS = 500;
const batch = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    rows: z.array(item).min(1).max(MAX_BATCH_ROWS),
    mode: z.enum(['UPSERT', 'CREATE_ONLY', 'UPDATE_ONLY']).default('UPSERT'),
    sourceLabel: z.string().trim().max(120).optional(),
  });

export const PersonBatchSchema = batch(PersonSchema);
export const AcademicUnitBatchSchema = batch(AcademicUnitSchema);
export const CourseBatchSchema = batch(CourseSchema);
export const EnrollmentBatchSchema = batch(EnrollmentSchema);

export const RosterRowResultSchema = z.object({
  index: z.number().int(),
  externalId: z.string().optional(),
  outcome: z.enum(['CREATED', 'UPDATED', 'UNCHANGED', 'REJECTED', 'IDENTITY_CONFLICT']),
  code: z.string().optional(),
  message: z.string().optional(),
});
export const RosterBatchResponseSchema = z.object({
  syncJobId: z.string().uuid(),
  summary: z.object({
    created: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    rejected: z.number().int(),
    identityConflicts: z.number().int(),
  }),
  rows: z.array(RosterRowResultSchema),
});
export type RosterBatchResponse = z.infer<typeof RosterBatchResponseSchema>;

/** Signed event envelope delivered to ERP webhooks and served by the cursor feed. */
export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(WEBHOOK_EVENT_TYPES),
  tenantId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  version: z.literal(1),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const WebhookEndpointCreateSchema = z.object({
  url: z.string().url().refine((u) => u.startsWith('https://') || process.env['EXAMOS_ALLOW_HTTP_WEBHOOKS'] === '1', 'Webhook URLs must use https'),
  description: z.string().trim().max(200).optional(),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

export const ApiKeyCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  expiresAt: z.string().datetime().optional(),
  allowedIps: z.array(z.union([z.ipv4(), z.ipv6()])).max(32).optional(),
});

export const MailCallbackSchema = z.object({
  dispatchId: z.string().uuid(),
  outcome: z.enum(['ACCEPTED', 'FAILED']),
  providerMessageId: z.string().max(256).optional(),
  error: z.string().max(2000).optional(),
});
export type MailCallback = z.infer<typeof MailCallbackSchema>;

export const EventsFeedQuerySchema = z.object({
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  types: z.string().optional(),
});
