/**
 * Canonical enums for SMRU ExamOS.
 *
 * These are the single vocabulary shared by the database check constraints,
 * the API (Zod) and the UI. Spec v3 used several overlapping vocabularies for
 * the same objects (Part I §5/§6, Part II §26, Part IV §46/§47); the
 * architecture review (v3.1, section 3) resolved them to the values below.
 */

export const EXAM_STATUSES = [
  'DRAFT',
  'PAPER_REVIEW',
  'APPROVED',
  'SCHEDULED',
  'PRECHECK',
  'LIVE',
  'CLOSED',
  'ARCHIVED',
  'CANCELLED',
] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];

export const PAPER_STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'SUPERSEDED'] as const;
export type PaperStatus = (typeof PAPER_STATUSES)[number];

/**
 * DESCRIPTIVE written answer · MCQ one correct option · MCQ_MULTI several correct options (partial credit, never below
 * zero) · NUMERIC a number (units, tolerance) · MATH an expression checked for mathematical equivalence · DRAWING a
 * diagram (examiner) · CODE a program run against the examiner's tests in a sandbox.
 */
export const QUESTION_KINDS = ['DESCRIPTIVE', 'MCQ', 'MCQ_MULTI', 'NUMERIC', 'MATH', 'DRAWING', 'CODE'] as const;
/** Languages a CODE question may allow: the full catalogue (with Judge0 ids) lives in code-languages.ts. */
export { CODE_LANGUAGES, type CodeLanguage } from './code-languages.js';
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const DOC_KINDS = ['BOOKLET_PDF', 'HALL_TICKET_PDF', 'EVIDENCE_PDF'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const STUDENT_DOCUMENT_KINDS = ['PHOTO', 'ID_CARD', 'HALL_TICKET'] as const;
export type StudentDocumentKind = (typeof STUDENT_DOCUMENT_KINDS)[number];

export const EVALUATOR_ROLE_TYPES = ['EVALUATOR_1', 'EVALUATOR_2', 'MODERATOR'] as const;
export type EvaluatorRoleType = (typeof EVALUATOR_ROLE_TYPES)[number];

export const EVALUATOR_ASSIGNMENT_STATUSES = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'REVOKED'] as const;
export type EvaluatorAssignmentStatus = (typeof EVALUATOR_ASSIGNMENT_STATUSES)[number];

export const MODERATION_REASONS = ['RANDOM_SAMPLE', 'DIVERGENCE_EXCEEDED', 'MANUAL'] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

export const MODERATION_STATUSES = ['PENDING', 'RESOLVED'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export const REVALUATION_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'DONE'] as const;
export type RevaluationStatus = (typeof REVALUATION_STATUSES)[number];

/** Pre-seal attempt states (Part II §26 wins over Part I §6). */
export const ATTEMPT_STATUSES = [
  'ALLOCATED',
  'PRECHECK_AVAILABLE',
  'PRECHECK_RUNNING',
  'READY',
  'ADMITTED',
  'ACTIVE',
  'RECOVERY_PENDING',
  'SUSPENDED',
  'SUBMITTING',
  'SUBMITTED',
  'EXPIRED',
  'VOIDED_BY_AUTHORITY',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** States in which the attempt is sealed: no answer mutation is ever accepted again. */
export const SEALED_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'SUBMITTED',
  'EXPIRED',
  'VOIDED_BY_AUTHORITY',
];

export const SUSPENSION_KINDS = ['WARNING_THRESHOLD', 'TECHNICAL_HOLD', 'PROCTOR_MANUAL'] as const;
export type SuspensionKind = (typeof SUSPENSION_KINDS)[number];

/** Post-seal candidate pipeline (Part IV §46.1, unchanged). */
export const CANDIDATE_STATUSES = [
  'ATTEMPT_SEALED',
  'FORENSIC_CHECKS_RUNNING',
  'FORENSIC_REVIEW_READY',
  'ACADEMIC_MARKING_READY',
  'EXAM_CELL_REVIEW',
  'CANDIDATE_APPROVED',
  'CONTROLLER_AUTHORIZED',
  'PUBLISHED',
  // exception states
  'TECHNICAL_REVIEW_REQUIRED',
  'IDENTITY_REVIEW_REQUIRED',
  'INTEGRITY_HOLD',
  'MARKING_MODERATION_REQUIRED',
  'REVALUATION_PENDING',
  'RESCHEDULE_APPROVED',
  'INVALIDATED_BY_AUTHORIZED_DECISION',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const EXAM_TYPES = ['MID_1', 'MID_2', 'SEM_INTERNAL', 'SEM_EXTERNAL', 'SUPPLEMENTARY', 'PRACTICAL', 'VIVA', 'ASSIGNMENT', 'OTHER'] as const;
export type ExamType = (typeof EXAM_TYPES)[number];

/** Examination Section exception codes (spec §27): scoped, time-bounded, justified, auditable. */
export const ADMISSION_EXCEPTION_CODES = ['ACC_APPROVED', 'TECH_ALT_DEVICE', 'PROCTOR_OVERRIDE', 'POLICY_INCOMPATIBILITY'] as const;
export type AdmissionExceptionCode = (typeof ADMISSION_EXCEPTION_CODES)[number];

export const SECURITY_PROFILES = ['PRACTICE', 'BASIC_BROWSER', 'SECURE_BYOD', 'MANAGED_ENDPOINT'] as const;
export type SecurityProfile = (typeof SECURITY_PROFILES)[number];

/** Aliases accepted on input from older spec vocabularies; stored values are always canonical. */
export const SECURITY_PROFILE_ALIASES: Record<string, SecurityProfile> = {
  BASIC: 'BASIC_BROWSER',
  SECURE: 'SECURE_BYOD',
  BYOD_STRICT: 'SECURE_BYOD',
  SECURE_BYOD_WITH_ROOM_INVIGILATOR: 'SECURE_BYOD',
  MANAGED_LAB: 'MANAGED_ENDPOINT',
  MANAGED_MAX: 'MANAGED_ENDPOINT',
};

export const ROLE_CODES = [
  'STUDENT',
  'QUESTION_SETTER',
  'PAPER_REVIEWER',
  'EVALUATOR',
  'MODERATOR',
  'PROCTOR',
  'CHIEF_PROCTOR',
  'HOD',
  'EXAM_CELL_OPERATOR',
  'CONTROLLER',
  'SYSTEM_ADMIN',
  'SECURITY_AUDITOR',
  'REPORT_VIEWER',
  'INTEGRATION_ADMIN',
  'TENANT_ADMIN',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_ACTIVATION'] as const;
export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
/** Named staff can hold several existing roles; no shared credentials. */
export const STAFF_BUNDLES = {
  ADMIN_CONTROLLER: ['TENANT_ADMIN', 'CONTROLLER', 'SECURITY_AUDITOR'],
  EXAM_OFFICE: ['EXAM_CELL_OPERATOR', 'QUESTION_SETTER'],
  CHIEF_REVIEWER: ['CHIEF_PROCTOR', 'PAPER_REVIEWER'],
  EXAMINER: ['EVALUATOR', 'MODERATOR'],
} as const satisfies Record<string, readonly RoleCode[]>;

export type StaffBundle = keyof typeof STAFF_BUNDLES;
export const STAFF_BUNDLE_CODES = Object.keys(STAFF_BUNDLES) as StaffBundle[];
/** Each tenant has 3 or 4 named staff logins in total (the tenant admin included); everyone else is a student. */
export const STAFF_LOGIN_LIMITS = [3, 4] as const;

/**
 * Device scan findings. BLOCKING findings stop admission (REMEDIATE) or raise an
 * incident during the exam; REVIEW findings are shown to a human. A clean
 * client scan is context, never proof.
 */
export const DEVICE_SCAN_FINDINGS = {
  MULTIPLE_DISPLAYS: 'BLOCKING',
  AUTOMATION_CONTROLLED: 'BLOCKING',
  VIRTUAL_MACHINE_SUSPECTED: 'BLOCKING',
  SCREEN_SHARING_ACTIVE: 'BLOCKING',
  FULLSCREEN_UNSUPPORTED: 'BLOCKING',
  COOKIES_DISABLED: 'BLOCKING',
  WINDOW_NOT_MAXIMISED: 'REVIEW',
  SMALL_VIEWPORT: 'REVIEW',
  REMOTE_DESKTOP_SUSPECTED: 'REVIEW',
  TIMEZONE_MISMATCH: 'REVIEW',
  LOW_BATTERY_UNPLUGGED: 'REVIEW',
  DEVTOOLS_SUSPECTED: 'REVIEW',
  DISPLAY_INFO_UNAVAILABLE: 'REVIEW',
} as const;
export type DeviceScanFinding = keyof typeof DEVICE_SCAN_FINDINGS;
export const DEVICE_SCAN_FINDING_CODES = Object.keys(DEVICE_SCAN_FINDINGS) as DeviceScanFinding[];
/** Which in-exam signal a blocking scan finding raises. */
export const DEVICE_SCAN_SIGNAL: Partial<Record<DeviceScanFinding, ProctorSignalClass>> = {
  MULTIPLE_DISPLAYS: 'DUAL_SCREEN_DETECTED',
  AUTOMATION_CONTROLLED: 'AUTOMATION_DETECTED',
  VIRTUAL_MACHINE_SUSPECTED: 'VIRTUAL_MACHINE_DETECTED',
  SCREEN_SHARING_ACTIVE: 'SCREEN_CAPTURE_ATTEMPT',
  REMOTE_DESKTOP_SUSPECTED: 'DISALLOWED_APP_DETECTED',
  DEVTOOLS_SUSPECTED: 'DEVTOOLS_ATTEMPT',
  WINDOW_NOT_MAXIMISED: 'WINDOW_RESIZED',
};

/** How the server treats a network address change during the exam (exam policy `ipPolicy`). */
export const IP_POLICIES = ['LOG', 'REVIEW', 'LOCK'] as const;
export type IpPolicy = (typeof IP_POLICIES)[number];

export const SCOPE_TYPES = ['TENANT', 'TENANT_GROUP', 'DEPARTMENT', 'PROGRAMME', 'COURSE', 'EXAM'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * Permissions are fine-grained and checked server-side on every request from
 * role_grants; they are never carried as JWT claims (review §2 item 12).
 */
export const PERMISSIONS = [
  'tenant:manage',
  'users:read',
  'users:write',
  'roster:read',
  'roster:write',
  'exams:read',
  'exams:write',
  'exams:allocate',
  'exams:conduct',
  'paper:write',
  'paper:review',
  'preflight:override',
  'preflight:override-security',
  'exports:read',
  'halltickets:issue',
  'attempts:own',
  'attempts:read',
  'proctor:events:ingest',
  'proctor:incidents:read',
  'proctor:incidents:decide',
  'proctor:attempts:resume',
  'proctor:attempts:hold',
  'marks:approve',
  'examcell:candidates:read',
  'examcell:candidates:approve',
  'controller:publish',
  'audit:read',
  'integration:manage',
  'mail:manage',
  'analytics:read',
  'evaluation:assign',
  'evaluation:moderate',
  'revaluation:request',
  'revaluation:decide',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  STUDENT: ['attempts:own', 'revaluation:request'],
  QUESTION_SETTER: ['exams:read', 'paper:write'],
  PAPER_REVIEWER: ['exams:read', 'paper:review'],
  EVALUATOR: ['exams:read', 'marks:approve'],
  MODERATOR: ['exams:read', 'marks:approve', 'evaluation:moderate'],
  PROCTOR: ['exams:read', 'attempts:read', 'proctor:incidents:read', 'proctor:incidents:decide', 'proctor:attempts:hold'],
  CHIEF_PROCTOR: [
    'exams:read',
    'exams:conduct',
    'attempts:read',
    'proctor:incidents:read',
    'proctor:incidents:decide',
    'proctor:attempts:resume',
    'proctor:attempts:hold',
  ],
  HOD: ['exams:read', 'roster:read', 'users:read', 'analytics:read'],
  EXAM_CELL_OPERATOR: [
    'exams:read',
    'exams:write',
    'exams:allocate',
    'exams:conduct',
    'paper:write',
    'paper:review',
    'preflight:override',
    'halltickets:issue',
    'exports:read',
    'roster:read',
    'users:read',
    'attempts:read',
    'examcell:candidates:read',
    'examcell:candidates:approve',
    'analytics:read',
    'evaluation:assign',
    'evaluation:moderate',
  ],
  CONTROLLER: [
    'exams:read',
    'exams:write',
    'exams:conduct',
    'paper:write',
    'paper:review',
    'preflight:override',
    'preflight:override-security',
    'exports:read',
    'attempts:read',
    'examcell:candidates:read',
    'controller:publish',
    'audit:read',
    'analytics:read',
    'evaluation:assign',
    'evaluation:moderate',
    'revaluation:decide',
  ],
  SYSTEM_ADMIN: ['tenant:manage', 'users:read', 'users:write', 'roster:read', 'roster:write', 'integration:manage', 'mail:manage', 'audit:read', 'analytics:read'],
  SECURITY_AUDITOR: ['audit:read', 'attempts:read', 'proctor:incidents:read'],
  REPORT_VIEWER: ['exams:read', 'analytics:read'],
  INTEGRATION_ADMIN: ['integration:manage', 'roster:read', 'roster:write'],
  TENANT_ADMIN: ['tenant:manage', 'users:read', 'users:write', 'roster:read', 'roster:write', 'integration:manage', 'mail:manage', 'exams:read', 'analytics:read'],
};

/** API-key scopes for the Simple Integration API (review §5). */
export const API_KEY_SCOPES = ['roster:write', 'roster:read', 'results:read', 'events:read', 'webhooks:manage', 'mail:callback'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const OUTBOX_CHANNELS = ['WEBHOOK', 'MAIL', 'INTERNAL'] as const;
export type OutboxChannel = (typeof OUTBOX_CHANNELS)[number];

export const OUTBOX_STATUSES = ['PENDING', 'PROCESSING', 'DONE', 'FAILED'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const WEBHOOK_EVENT_TYPES = [
  'roster.sync.completed',
  'exam.scheduled',
  'exam.allocation.changed',
  'attempt.admitted',
  'attempt.submitted',
  'candidate.held',
  'candidate.approved',
  'result.published',
  'result.corrected',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'RETRYING', 'DEAD'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const MAIL_CATEGORIES = [
  'ACCOUNT_ACTIVATION',
  'REHEARSAL_REMINDER',
  'PREFLIGHT_REMINDER',
  'ADMISSION_RECEIPT',
  'TECHNICAL_HOLD_TICKET',
  'SUSPENSION_ALERT',
  'RESULT_PUBLISHED',
  'CANDIDATE_HOLD_NOTICE',
  'EXAM_CELL_DIGEST',
  'SECURITY_ALERT',
  'REVALUATION_DECISION',
] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/** Transactional mail (activation, receipts) never waits behind bulk reminder waves. */
export const MAIL_LANES = ['TRANSACTIONAL', 'BULK'] as const;
export type MailLane = (typeof MAIL_LANES)[number];
export const MAIL_CATEGORY_LANE: Record<MailCategory, MailLane> = {
  ACCOUNT_ACTIVATION: 'TRANSACTIONAL',
  REHEARSAL_REMINDER: 'BULK',
  PREFLIGHT_REMINDER: 'BULK',
  ADMISSION_RECEIPT: 'TRANSACTIONAL',
  TECHNICAL_HOLD_TICKET: 'TRANSACTIONAL',
  SUSPENSION_ALERT: 'TRANSACTIONAL',
  RESULT_PUBLISHED: 'BULK',
  CANDIDATE_HOLD_NOTICE: 'TRANSACTIONAL',
  EXAM_CELL_DIGEST: 'BULK',
  SECURITY_ALERT: 'TRANSACTIONAL',
  REVALUATION_DECISION: 'TRANSACTIONAL',
};

export const MAIL_STATUSES = ['QUEUED', 'SENDING', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

export const MAIL_TRANSPORT_KINDS = ['power-automate', 'smtp-oauth2', 'graph', 'smtp-relay', 'capture', 'acs-email', 'ses'] as const;
export type MailTransportKind = (typeof MAIL_TRANSPORT_KINDS)[number];

export const ERP_CONNECTION_PROVIDERS = ['uos', 'generic-rest', 'sap', 'ellucian'] as const;
export type ErpConnectionProvider = (typeof ERP_CONNECTION_PROVIDERS)[number];

export const ERP_SYNC_ENTITIES = ['ALL', 'PERSON', 'ACADEMIC_UNIT', 'COURSE', 'ENROLLMENT'] as const;
export type ErpSyncEntity = (typeof ERP_SYNC_ENTITIES)[number];

export const ROSTER_SYNC_SOURCES = ['PUSH_API', 'XLSX', 'ADAPTER'] as const;
export type RosterSyncSource = (typeof ROSTER_SYNC_SOURCES)[number];

export const ROSTER_SYNC_STATUSES = ['RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] as const;
export type RosterSyncStatus = (typeof ROSTER_SYNC_STATUSES)[number];

export const ROSTER_ROW_OUTCOMES = ['CREATED', 'UPDATED', 'UNCHANGED', 'REJECTED', 'IDENTITY_CONFLICT'] as const;
export type RosterRowOutcome = (typeof ROSTER_ROW_OUTCOMES)[number];

export const PROCTOR_SIGNAL_CLASSES = [
  'FOCUS_LOST',
  'FULLSCREEN_EXIT',
  'CONCURRENT_SESSION',
  'DISALLOWED_APP_DETECTED',
  'UNAPPROVED_DEVICE',
  'VIRTUAL_MACHINE_DETECTED',
  'DUAL_SCREEN_DETECTED',
  /** Strict-lockdown signals reported by the exam workspace; human review only, never auto-counted. */
  'CLIPBOARD_ATTEMPT',
  'DEVTOOLS_ATTEMPT',
  'SCREEN_CAPTURE_ATTEMPT',
  'MULTIPLE_TABS',
  'WINDOW_RESIZED',
  'AUTOMATION_DETECTED',
  /** The display configuration changed mid-exam: a monitor or projector added/removed, mirroring, resolution or scaling. */
  'DISPLAY_CHANGED',
  /** On-device camera presence check: no face in view for a sustained period, or the camera view is covered. */
  'FACE_NOT_VISIBLE',
  /** Server-observed: an exam that requires Safe Exam Browser was reached without a valid SEB key hash. */
  'SECURE_CLIENT_MISSING',
  /** Server-observed: the attempt was reached from a new network address (context for a human). */
  'NETWORK_ADDRESS_CHANGED',
  'NETWORK_ANOMALY',
  'CAMERA_UNAVAILABLE',
  'PERSON_POSSIBLE',
  'MULTIPLE_PERSON_POSSIBLE',
  'RECORDING_GAP',
  'VISUAL_ANOMALY',
  'OTHER_MANUAL',
] as const;
export type ProctorSignalClass = (typeof PROCTOR_SIGNAL_CLASSES)[number];

/**
 * Signal classes that can never become a countable warning without a human
 * decision (spec §9, §30, §43). Technical classes are never countable at all.
 */
export const TECHNICAL_SIGNAL_CLASSES: readonly ProctorSignalClass[] = ['NETWORK_ANOMALY', 'CAMERA_UNAVAILABLE', 'RECORDING_GAP'];
export const HUMAN_REVIEW_ONLY_SIGNAL_CLASSES: readonly ProctorSignalClass[] = [
  'PERSON_POSSIBLE',
  'MULTIPLE_PERSON_POSSIBLE',
  'VISUAL_ANOMALY',
  'OTHER_MANUAL',
  'DISALLOWED_APP_DETECTED',
  'UNAPPROVED_DEVICE',
  'VIRTUAL_MACHINE_DETECTED',
  'DUAL_SCREEN_DETECTED',
  'CLIPBOARD_ATTEMPT',
  'DEVTOOLS_ATTEMPT',
  'SCREEN_CAPTURE_ATTEMPT',
  'MULTIPLE_TABS',
  'WINDOW_RESIZED',
  'AUTOMATION_DETECTED',
  'DISPLAY_CHANGED',
  'FACE_NOT_VISIBLE',
  'SECURE_CLIENT_MISSING',
  'NETWORK_ADDRESS_CHANGED',
];
/** Classes only the server may raise; a client report of these is refused at ingest. */
export const SERVER_ONLY_SIGNAL_CLASSES: readonly ProctorSignalClass[] = ['CONCURRENT_SESSION', 'NETWORK_ADDRESS_CHANGED', 'SECURE_CLIENT_MISSING'];
/** The only class the server may count deterministically: it is server-observed, not client-reported. */
export const SERVER_VERIFIED_COUNTABLE_CLASSES: readonly ProctorSignalClass[] = ['CONCURRENT_SESSION'];

export const INCIDENT_STATUSES = ['TECHNICAL', 'DISMISSED', 'PROCTOR_REVIEW', 'CONFIRMED_COUNTABLE_WARNING'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const PROCTOR_DECISION_ACTIONS = ['DISMISS', 'CONFIRM_WARNING', 'MARK_TECHNICAL', 'ESCALATE', 'INVALIDATE_REQUEST'] as const;
export type ProctorDecisionAction = (typeof PROCTOR_DECISION_ACTIONS)[number];

export const WARNING_THRESHOLD_DEFAULT = 5;

export const PRECHECK_STATUSES = ['RUNNING', 'READY', 'REMEDIATE', 'REVIEW', 'EXPIRED'] as const;
export type PrecheckStatus = (typeof PRECHECK_STATUSES)[number];

export const PRECHECK_ITEM_STATUSES = ['PENDING', 'PASS', 'REMEDIATE', 'UNVERIFIABLE', 'NEED_HELP'] as const;
export type PrecheckItemStatus = (typeof PRECHECK_ITEM_STATUSES)[number];

/** Checks the server can measure itself; anything else is reported UNVERIFIABLE unless a validated client asserts it. */
export const PRECHECK_CHECK_CODES = [
  'IDENTITY_SESSION',
  'ELIGIBILITY',
  'CLIENT_VERSION',
  'NETWORK_SAVE_ROUNDTRIP',
  'CLOCK_SYNC',
  'KEYBOARD_INPUT',
  'CANVAS_INPUT',
  'CAMERA',
  'MICROPHONE',
  'CONSENT',
  /** Client system-settings scan (displays, automation, virtualisation, browser capabilities). */
  'SYSTEM_SCAN',
] as const;
export type PrecheckCheckCode = (typeof PRECHECK_CHECK_CODES)[number];
/** Checks whose failure only a Controller-level `preflight:override-security` may waive (spec §27). */
export const SECURITY_REQUIRED_CHECKS: readonly PrecheckCheckCode[] = ['IDENTITY_SESSION', 'ELIGIBILITY', 'CLIENT_VERSION', 'CONSENT'];
export const SERVER_MEASURABLE_CHECKS: readonly PrecheckCheckCode[] = ['IDENTITY_SESSION', 'ELIGIBILITY', 'CLIENT_VERSION', 'NETWORK_SAVE_ROUNDTRIP', 'CLOCK_SYNC', 'CONSENT'];
export const MANDATORY_CHECKS_BY_PROFILE: Record<SecurityProfile, readonly PrecheckCheckCode[]> = {
  PRACTICE: ['IDENTITY_SESSION'],
  BASIC_BROWSER: ['IDENTITY_SESSION', 'ELIGIBILITY', 'NETWORK_SAVE_ROUNDTRIP', 'CLOCK_SYNC', 'KEYBOARD_INPUT', 'SYSTEM_SCAN'],
  SECURE_BYOD: ['IDENTITY_SESSION', 'ELIGIBILITY', 'CLIENT_VERSION', 'NETWORK_SAVE_ROUNDTRIP', 'CLOCK_SYNC', 'KEYBOARD_INPUT', 'CONSENT', 'SYSTEM_SCAN'],
  MANAGED_ENDPOINT: ['IDENTITY_SESSION', 'ELIGIBILITY', 'CLIENT_VERSION', 'NETWORK_SAVE_ROUNDTRIP', 'CLOCK_SYNC', 'KEYBOARD_INPUT', 'CONSENT', 'SYSTEM_SCAN'],
};
