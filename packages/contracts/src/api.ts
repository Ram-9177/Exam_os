import { z } from 'zod';
import {
  PROCTOR_DECISION_ACTIONS,
  PROCTOR_SIGNAL_CLASSES,
  SECURITY_PROFILES,
  SECURITY_PROFILE_ALIASES,
  ROLE_CODES,
  SCOPE_TYPES,
  PRECHECK_CHECK_CODES,
  EXAM_TYPES,
  ADMISSION_EXCEPTION_CODES,
  PAPER_STATUSES,
  QUESTION_KINDS,
  EVALUATOR_ROLE_TYPES,
  EVALUATOR_ASSIGNMENT_STATUSES,
  MODERATION_REASONS,
  MODERATION_STATUSES,
  REVALUATION_STATUSES,
  STAFF_BUNDLE_CODES,
  DEVICE_SCAN_FINDING_CODES,
  IP_POLICIES,
  type StaffBundle,
  type DeviceScanFinding,
} from './enums.js';

/** RFC 7807-style error envelope used by every route (spec §33). */
export const ProblemSchema = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string(),
  retryable: z.boolean().default(false),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const UUID = z.string().uuid();

// ---------- auth ----------
export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(256),
});
export const RefreshSchema = z.object({ refreshToken: z.string().min(20) });
export const ActivateSchema = z.object({ token: z.string().min(20), password: z.string().min(12).max(256) });

// ---------- users / roles ----------
export const UserCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1).max(200),
  kind: z.enum(['STUDENT', 'STAFF']).default('STUDENT'),
  externalId: z.string().trim().max(128).optional(),
  provider: z.string().trim().max(64).optional(),
  roles: z
    .array(
      z.object({
        role: z.enum(ROLE_CODES),
        scopeType: z.enum(SCOPE_TYPES).default('TENANT'),
        scopeId: UUID.optional(),
      }),
    )
    .default([]),
  /** Staff only: grant a whole duty bundle (tenant-wide) instead of listing roles. */
  bundle: z.enum(STAFF_BUNDLE_CODES as [StaffBundle, ...StaffBundle[]]).optional(),
  sendActivation: z.boolean().default(true),
});

// ---------- exams ----------
export const SecurityProfileInput = z
  .string()
  .transform((v) => SECURITY_PROFILE_ALIASES[v] ?? v)
  .pipe(z.enum(SECURITY_PROFILES));

export const ExamCreateSchema = z.object({
  code: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  courseCode: z.string().trim().min(1).max(64),
  examType: z.enum(EXAM_TYPES).default('SEM_INTERNAL'),
  academicYear: z.string().regex(/^\d{4}-\d{2,4}$/).optional(),
  semester: z.number().int().min(1).max(20).optional(),
  maxMarks: z.number().positive().max(1000).optional(),
  securityProfile: SecurityProfileInput.default('SECURE_BYOD'),
  durationMinutes: z.number().int().min(5).max(600),
  windowStartAt: z.string().datetime(),
  windowEndAt: z.string().datetime(),
  warningThreshold: z.number().int().min(1).max(20).default(5),
  policy: z.record(z.string(), z.unknown()).default({}),
});

export const AllocationSchema = z.object({
  studentExternalIds: z.array(z.string().trim().min(1)).min(1).max(5000),
  extraTimeMinutes: z.number().int().min(0).max(240).default(0),
  accommodationRef: z.string().max(64).optional(),
});

// ---------- preflight / admission ----------
export const PrecheckItemVerifySchema = z.object({
  code: z.enum(PRECHECK_CHECK_CODES),
  /** Client-declared evidence; the server decides the status. */
  clientBuild: z.string().max(64).optional(),
  clientClockMs: z.number().int().optional(),
  consentPolicyVersion: z.string().max(32).optional(),
  keyboardSample: z.string().max(2000).optional(),
  canvasOps: z.number().int().min(0).optional(),
  /** SYSTEM_SCAN evidence: the client's raw scan; the server derives findings itself. */
  scan: z.lazy(() => DeviceScanSchema).optional(),
});

/**
 * Raw system-settings scan taken by the exam client. Every field is a
 * client observation; the server recomputes findings from these values and
 * never accepts a client-declared verdict.
 */
export const DeviceScanSchema = z.object({
  takenAt: z.string().datetime(),
  userAgent: z.string().max(512),
  platform: z.string().max(64).optional(),
  language: z.string().max(32).optional(),
  timezone: z.string().max(64).optional(),
  screen: z.object({
    width: z.number().int().min(0).max(20000),
    height: z.number().int().min(0).max(20000),
    availWidth: z.number().int().min(0).max(20000),
    availHeight: z.number().int().min(0).max(20000),
    colorDepth: z.number().int().min(0).max(64),
    pixelRatio: z.number().min(0).max(10),
    /** window.screen.isExtended; null when the browser does not expose it. */
    isExtended: z.boolean().nullable(),
    /** Count from getScreenDetails() when permitted; null when unavailable. */
    displayCount: z.number().int().min(0).max(16).nullable(),
  }),
  window: z.object({ innerWidth: z.number().int().min(0).max(20000), innerHeight: z.number().int().min(0).max(20000), outerWidth: z.number().int().min(0).max(20000), outerHeight: z.number().int().min(0).max(20000) }),
  hardware: z.object({ cores: z.number().int().min(0).max(1024).nullable(), memoryGb: z.number().min(0).max(1024).nullable(), touchPoints: z.number().int().min(0).max(64), pointerFine: z.boolean() }),
  gpu: z.object({ vendor: z.string().max(200).nullable(), renderer: z.string().max(300).nullable() }),
  browser: z.object({
    webdriver: z.boolean(),
    cookiesEnabled: z.boolean(),
    fullscreenSupported: z.boolean(),
    pdfViewer: z.boolean().nullable(),
    pluginsCount: z.number().int().min(0).max(1000),
    /** Display media capture currently running in this page (should be false). */
    displayCaptureActive: z.boolean(),
    devtoolsHeuristic: z.boolean(),
  }),
  network: z.object({ effectiveType: z.string().max(16).nullable(), downlinkMbps: z.number().min(0).max(100000).nullable(), rttMs: z.number().min(0).max(100000).nullable(), online: z.boolean() }),
  battery: z.object({ level: z.number().min(0).max(1), charging: z.boolean() }).nullable(),
  visibility: z.enum(['visible', 'hidden', 'prerender', 'unloaded']).optional(),
});
export type DeviceScan = z.infer<typeof DeviceScanSchema>;
export const DeviceScanReportSchema = z.object({ scan: DeviceScanSchema });
export const DeviceScanFindingSchema = z.enum(DEVICE_SCAN_FINDING_CODES as [DeviceScanFinding, ...DeviceScanFinding[]]);

export const AdmissionExceptionSchema = z.object({
  exceptionCode: z.enum(ADMISSION_EXCEPTION_CODES),
  coversChecks: z.array(z.enum(PRECHECK_CHECK_CODES)).min(1),
  reason: z.string().trim().min(5).max(2000),
  expiresInMinutes: z.number().int().min(5).max(600).default(120),
});

export const HallTicketIssueSchema = z.object({
  /** Optional explicit numbers; otherwise generated as <examCode>-<sequence>. */
  numbers: z.record(z.string().uuid(), z.string().trim().min(3).max(40)).optional(),
});

// ---------- question papers ----------
export const PaperSectionSchema = z.object({
  code: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(100),
  instructions: z.string().max(2000).optional(),
});
export type PaperSection = z.infer<typeof PaperSectionSchema>;

export const PaperQuestionRubricCriterionSchema = z.object({
  code: z.string().trim().min(1).max(32),
  max: z.number().positive().max(1000),
  description: z.string().trim().min(1).max(500),
});
export type PaperQuestionRubricCriterion = z.infer<typeof PaperQuestionRubricCriterionSchema>;

export const PaperQuestionInputSchema = z.object({
  questionId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  sectionCode: z.string().trim().min(1).max(32),
  number: z.number().int().min(1),
  kind: z.enum(QUESTION_KINDS),
  prompt: z.object({ blocks: z.array(z.record(z.string(), z.unknown())) }),
  options: z.array(z.object({ key: z.string().trim().min(1).max(16), text: z.string().trim().min(1).max(1000) })).optional(),
  maxMarks: z.number().positive().max(1000),
  rubric: z.array(PaperQuestionRubricCriterionSchema).optional(),
  expectedAnswer: z.unknown().optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type PaperQuestionInput = z.infer<typeof PaperQuestionInputSchema>;

export const PaperUpsertSchema = z.object({
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(4000).optional(),
  sections: z.array(PaperSectionSchema).min(1),
  questions: z.array(PaperQuestionInputSchema).min(1),
});
export type PaperUpsert = z.infer<typeof PaperUpsertSchema>;

export const PaperSetCreateSchema = z.object({
  setCode: z.string().trim().regex(/^[A-Za-z0-9_-]{1,16}$/),
  questionOrder: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).min(1),
});
export type PaperSetCreate = z.infer<typeof PaperSetCreateSchema>;

export const PaperReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  feedback: z.string().trim().max(2000).optional(),
});
export type PaperReviewDecision = z.infer<typeof PaperReviewDecisionSchema>;

// ---------- attempts / answers ----------
export const ANSWER_BLOCK_KINDS = ['paragraph', 'equation', 'table', 'canvas', 'choice'] as const;
export type AnswerBlockKind = (typeof ANSWER_BLOCK_KINDS)[number];

/** Whiteboard colours are named, so every renderer (canvas, SVG, PDF) draws the same ink. */
export const CANVAS_COLORS = { ink: '#1a2030', blue: '#1d4ed8', red: '#b91c1c', green: '#15803d', orange: '#c2410c', purple: '#7e22ce' } as const;
export type CanvasColor = keyof typeof CANVAS_COLORS;
export const CANVAS_TOOLS = ['pen', 'highlighter', 'eraser', 'line', 'arrow', 'rect', 'ellipse', 'text'] as const;
export const CANVAS_BACKGROUNDS = ['blank', 'grid', 'ruled', 'dots'] as const;
export const CANVAS_LIMITS = { maxItems: 3000, maxPointsPerStroke: 6000, maxTotalPoints: 120_000, maxTextLength: 500, minSize: 100, maxWidth: 2400, maxHeight: 4800 } as const;
const CanvasPoint = z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number().min(0).max(1)])]);
export const CanvasItemSchema = z.object({
  tool: z.enum(CANVAS_TOOLS),
  width: z.number().min(0.5).max(80),
  color: z.enum(Object.keys(CANVAS_COLORS) as [CanvasColor, ...CanvasColor[]]).optional(),
  points: z.array(CanvasPoint).min(1).max(CANVAS_LIMITS.maxPointsPerStroke),
  /** Shapes only: draw filled (translucent). */
  fill: z.boolean().optional(),
  /** Text only. */
  text: z.string().max(CANVAS_LIMITS.maxTextLength).optional(),
  size: z.number().min(8).max(96).optional(),
});
export const CanvasContentSchema = z
  .object({
    width: z.number().min(CANVAS_LIMITS.minSize).max(CANVAS_LIMITS.maxWidth),
    height: z.number().min(CANVAS_LIMITS.minSize).max(CANVAS_LIMITS.maxHeight),
    background: z.enum(CANVAS_BACKGROUNDS).optional(),
    strokes: z.array(CanvasItemSchema).max(CANVAS_LIMITS.maxItems),
  })
  .superRefine((c, ctx) => {
    let total = 0;
    for (const [i, s] of c.strokes.entries()) {
      total += s.points.length;
      if (s.tool === 'text' && !s.text) ctx.addIssue({ code: 'custom', path: ['strokes', i, 'text'], message: 'text items need text' });
      if (['line', 'arrow', 'rect', 'ellipse'].includes(s.tool) && s.points.length !== 2) ctx.addIssue({ code: 'custom', path: ['strokes', i, 'points'], message: 'shapes have exactly two points' });
      for (const p of s.points) if (p[0] < -10 || p[1] < -10 || p[0] > c.width + 10 || p[1] > c.height + 10) { ctx.addIssue({ code: 'custom', path: ['strokes', i, 'points'], message: 'point outside the canvas' }); break; }
    }
    if (total > CANVAS_LIMITS.maxTotalPoints) ctx.addIssue({ code: 'custom', path: ['strokes'], message: 'drawing too large' });
  });
export type CanvasContentWire = z.infer<typeof CanvasContentSchema>;
/** MCQ answer: the selected option key (or null when cleared). */
export const ChoiceContentSchema = z.object({ selected: z.string().min(1).max(16).nullable() });
export const PARAGRAPH_MAX_CHARS = 50_000;
export const AnswerOpSchema = z.object({
  op: z.enum(['upsert-block', 'delete-block', 'reorder']),
  blockId: z.string().min(1).max(64),
  kind: z.enum(ANSWER_BLOCK_KINDS).optional(),
  content: z.unknown().optional(),
  after: z.string().max(64).nullable().optional(),
});

export const AnswerSaveSchema = z.object({
  clientOperationId: UUID,
  baseRevision: z.number().int().min(0),
  answerFormat: z.literal('hybrid-v1'),
  ops: z.array(AnswerOpSchema).min(1).max(200),
  /** SHA-256 of the client's rendered document after applying ops; verified against the server's. */
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AnswerSave = z.infer<typeof AnswerSaveSchema>;

export const AnswerSaveResponseSchema = z.object({
  accepted: z.literal(true),
  serverRevision: z.number().int(),
  receiptId: UUID,
  serverSavedAt: z.string().datetime(),
  contentSha256: z.string(),
  duplicate: z.boolean(),
});

export const SubmitSchema = z.object({ idempotencyKey: UUID });

// ---------- proctoring ----------
export const ProctorEventIngestSchema = z.object({
  events: z
    .array(
      z.object({
        sourceEventId: z.string().min(1).max(128),
        attemptId: UUID,
        signalClass: z.enum(PROCTOR_SIGNAL_CLASSES),
        clientRecordedAt: z.string().datetime().optional(),
        clientSequence: z.number().int().optional(),
        // Client context for the human reading the incident (reason, time away, display before/after). Bounded:
        // it is evidence shown to a person, never a carrier for anything else.
        metadata: z
          .record(z.string(), z.unknown())
          .default({})
          .refine((m) => JSON.stringify(m).length <= 2048, { message: 'metadata must be at most 2 KB of JSON' }),
      }),
    )
    .min(1)
    .max(200),
});

export const ProctorDecisionSchema = z.object({
  action: z.enum(PROCTOR_DECISION_ACTIONS),
  reasonCode: z.string().trim().min(1).max(64),
  notes: z.string().trim().max(2000).optional(),
  idempotencyKey: UUID,
});

export const ResumeSchema = z.object({
  reasonCode: z.string().trim().min(1).max(64),
  notes: z.string().trim().min(1).max(2000),
  idempotencyKey: UUID,
  deadlineExtensionMinutes: z.number().int().min(0).max(240).default(0),
  /** Student continues on a replacement device (loaner); the next reconnect binds it. */
  rebindDevice: z.boolean().default(false),
});

export const TechnicalHoldSchema = z.object({
  reasonCode: z.string().trim().min(1).max(64),
  notes: z.string().trim().max(2000).optional(),
  idempotencyKey: UUID,
});

// ---------- candidates ----------
export const CandidateApprovalSchema = z.object({
  reviewedResultVersionId: UUID,
  reason: z.string().trim().min(1).max(2000),
  idempotencyKey: UUID,
});
export const ControllerAuthorizeSchema = z.object({
  candidateApprovalId: UUID,
  idempotencyKey: UUID,
});

// ---------- tenants ----------
export const TenantCreateSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, "lowercase slug, 2-40 chars"),
  name: z.string().trim().min(1).max(200),
  groupCode: z.string().trim().max(64).optional(),
  timezone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  domains: z.array(z.string().trim().toLowerCase().min(3).max(253)).default([]),
  adminEmail: z.string().trim().toLowerCase().email(),
  adminFullName: z.string().trim().min(1).max(200),
  /** Named staff logins for the whole campus (admin included): 3 or 4. */
  staffLoginLimit: z.union([z.literal(3), z.literal(4)]).default(4),
  /** Duties held by the first admin login. */
  adminBundle: z.enum(STAFF_BUNDLE_CODES as [StaffBundle, ...StaffBundle[]]).default('ADMIN_CONTROLLER'),
});

export const TenantMailConfigSchema = z.object({
  transportKind: z.enum(['power-automate', 'smtp-oauth2', 'graph', 'smtp-relay', 'capture']),
  senderAddress: z.string().trim().toLowerCase().email(),
  senderName: z.string().trim().max(120).default('Examination Cell'),
  /** vault references, never secrets */
  endpointRef: z.string().max(200).optional(),
  tokenRef: z.string().max(200).optional(),
  callbackSecretRef: z.string().max(200).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

// ---------- student profile & id card (phase 3) ----------
export const PhotoUploadSchema = z.object({
  consentGiven: z.literal(true, {
    message: 'Explicit consent is required to store your profile photo for university examination records',
  }),
  dataUrl: z.string().trim().regex(/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Photo must be a base64 data URL (JPEG, PNG, or WebP)'),
});
export type PhotoUploadInput = z.infer<typeof PhotoUploadSchema>;

export interface StudentProfileData {
  student: {
    id: string;
    fullName: string;
    email: string;
    registerNumber: string | null;
    admissionBatch: string | null;
    currentSemester: number | null;
    section: string | null;
    preferredLanguage: string | null;
  };
  department: {
    id: string;
    code: string;
    name: string;
  } | null;
  programme: {
    id: string;
    code: string;
    name: string;
  } | null;
  documents: {
    photo: {
      sha256: string;
      createdAt: string;
      mimeType: string;
    } | null;
  };
  hallTickets: Array<{
    examId: string;
    examCode: string;
    examTitle: string;
    examType: string;
    hallTicketNumber: string;
    hallTicketVerification: string;
    windowStartAt: string;
    windowEndAt: string;
  }>;
  cumulative: {
    totalExams: number;
    totalMarks: number;
    totalMax: number;
    percentage: number;
    gpa: number;
  };
}

export interface IdCardVerificationData {
  valid: boolean;
  tenantName: string;
  fullName: string;
  registerNumber: string;
  departmentCode: string | null;
  departmentName: string | null;
  programmeCode: string | null;
  programmeName: string | null;
  currentSemester: number | null;
  photoAvailable: boolean;
  issuedAt: string;
}

export interface DepartmentAnalyticsData {
  department: {
    id: string;
    code: string;
    name: string;
  };
  summary: {
    totalStudents: number;
    totalExams: number;
    totalPublishedResults: number;
    avgPercentage: number;
    passCount: number;
    failCount: number;
    passRate: number;
  };
  semesterRollups: Array<{
    academicYear: string;
    semester: number | null;
    examsCount: number;
    studentCount: number;
    avgPercentage: number;
    passRate: number;
  }>;
  examRollups: Array<{
    examId: string;
    examCode: string;
    examTitle: string;
    examType: string;
    maxMarks: number;
    avgMarks: number;
    highestMarks: number;
    lowestMarks: number;
    candidateCount: number;
    passCount: number;
    passRate: number;
  }>;
}

// ---------- Phase 4: Secure Client & SEB ----------
export const SebConfigGenerateSchema = z.object({
  allowQuit: z.boolean().default(true),
  quitPassword: z.string().min(6).max(64).optional(),
  kioskMode: z.boolean().default(true),
  blockVirtualMachines: z.boolean().default(true),
  blockScreenCapture: z.boolean().default(true),
  blockClipboard: z.boolean().default(true),
  /** Added to the built-in force-quit list: `Name.exe` (Windows) or a macOS bundle identifier (com.vendor.app). */
  prohibitedProcesses: z.array(z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9 ._()+-]+$/)).max(100).optional(),
});
export type SebConfigGenerateInput = z.infer<typeof SebConfigGenerateSchema>;

export const ExamClientPolicyUpdateSchema = z.object({
  sebConfigKey: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  /** Browser Exam Keys from the SEB Config Tool, one per approved SEB build; when set, every gated request must match one. */
  sebBrowserExamKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/i)).max(20).optional(),
  allowedClientBuilds: z.array(z.string().min(1).max(64)).optional(),
  requireManagedEndpoint: z.boolean().optional(),
  allowedSubnets: z.array(z.string().min(1).max(64)).optional(),
  /**
   * On-device camera presence check during the exam: a face detector on the student's own device reports "no face in
   * view", "camera covered" and "more than one face" as signals for a human. No image or video leaves the device.
   * Turning it on adds the CAMERA consent and starts a new policy version (earlier readiness runs must be repeated).
   */
  cameraPresence: z.boolean().optional(),
  /** What an in-exam network address change does: LOG (default), REVIEW (signal for a human), LOCK (writes held to the admitted address). */
  ipPolicy: z.enum(IP_POLICIES).optional(),
});
export type ExamClientPolicyUpdate = z.infer<typeof ExamClientPolicyUpdateSchema>;

export interface SebConfigResult {
  sebConfigKey: string;
  generatedAt: string;
  downloadUrl: string;
}

// ---------- Phase 6: Evaluation at Scale, Moderation & Revaluation ----------
export const EvaluatorAssignSchema = z.object({
  evaluatorUserId: UUID,
  roleType: z.enum(EVALUATOR_ROLE_TYPES).default('EVALUATOR_1'),
  attemptIds: z.array(UUID).optional(),
  count: z.number().int().positive().max(1000).optional(),
});
export type EvaluatorAssignInput = z.infer<typeof EvaluatorAssignSchema>;

export const DoubleEvaluationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  divergenceThresholdPct: z.number().min(0).max(100).default(15),
  randomModerationPct: z.number().min(0).max(100).default(10),
  anonymizeEvaluation: z.boolean().default(true),
});
export type DoubleEvaluationConfig = z.infer<typeof DoubleEvaluationConfigSchema>;

export interface ResultItem {
  questionId: string;
  maxMarks: number;
  marks: number;
  explanation: string;
  criteria?: Array<{ code: string; max: number; awarded: number; evidence?: string }>;
}

export const ModerationResolveSchema = z.object({
  resolutionNote: z.string().trim().min(5).max(2000),
  items: z
    .array(
      z.object({
        questionId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        maxMarks: z.number().min(0).max(1000),
        marks: z.number().min(0).max(1000),
        explanation: z.string().trim().min(1).max(4000),
        criteria: z
          .array(
            z.object({
              code: z.string().min(1).max(64),
              max: z.number().min(0),
              awarded: z.number().min(0),
              evidence: z.string().max(2000).optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type ModerationResolveInput = z.infer<typeof ModerationResolveSchema>;

export const RevaluationRequestSchema = z.object({
  reason: z.string().trim().min(5).max(2000),
  feeRef: z.string().trim().max(100).optional(),
});
export type RevaluationRequestInput = z.infer<typeof RevaluationRequestSchema>;

export const RevaluationDecideSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().trim().max(2000).optional(),
});
export type RevaluationDecideInput = z.infer<typeof RevaluationDecideSchema>;

export const SimilarityAnalysisSchema = z.object({
  threshold: z.number().min(0.5).max(1.0).default(0.85),
});
export type SimilarityAnalysisInput = z.infer<typeof SimilarityAnalysisSchema>;

export interface EvaluatorAssignmentSummary {
  evaluatorId: string;
  evaluatorName: string;
  evaluatorEmail: string;
  totalAssigned: number;
  inProgress: number;
  completed: number;
}

// ---------------------------------------------------------------- Phase 7: ERP Adapters, XLSX & Mail
export const ErpConnectionCreateSchema = z.object({
  provider: z.enum(['uos', 'generic-rest', 'sap', 'ellucian']),
  label: z.string().trim().min(1).max(100),
  baseUrl: z.string().url().max(2000),
  credentialSecret: z.string().max(4000).optional(),
  webhookSecret: z.string().max(4000).optional(),
  syncScheduleCron: z.string().trim().max(100).nullable().optional(),
  mapping: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
});
export type ErpConnectionCreateInput = z.infer<typeof ErpConnectionCreateSchema>;

export const ErpConnectionUpdateSchema = ErpConnectionCreateSchema.partial();
export type ErpConnectionUpdateInput = z.infer<typeof ErpConnectionUpdateSchema>;

export const ErpSyncRequestSchema = z.object({
  entity: z.enum(['ALL', 'PERSON', 'ACADEMIC_UNIT', 'COURSE', 'ENROLLMENT']).default('ALL'),
  mode: z.enum(['UPSERT', 'CREATE_ONLY', 'UPDATE_ONLY']).default('UPSERT'),
  dryRun: z.boolean().default(false),
});
export type ErpSyncRequestInput = z.infer<typeof ErpSyncRequestSchema>;

export const XlsxPreviewRequestSchema = z.object({
  entity: z.enum(['PERSON', 'ACADEMIC_UNIT', 'COURSE', 'ENROLLMENT']),
  csvContent: z.string().min(1),
  mode: z.enum(['UPSERT', 'CREATE_ONLY', 'UPDATE_ONLY']).default('UPSERT'),
  provider: z.string().min(1).max(32).default('xlsx'),
});
export type XlsxPreviewRequestInput = z.infer<typeof XlsxPreviewRequestSchema>;

export const XlsxImportRequestSchema = z.object({
  entity: z.enum(['PERSON', 'ACADEMIC_UNIT', 'COURSE', 'ENROLLMENT']),
  csvContent: z.string().min(1),
  mode: z.enum(['UPSERT', 'CREATE_ONLY', 'UPDATE_ONLY']).default('UPSERT'),
  provider: z.string().min(1).max(32).default('xlsx'),
  sourceLabel: z.string().max(255).optional(),
});
export type XlsxImportRequestInput = z.infer<typeof XlsxImportRequestSchema>;

export const MailBounceReconcileSchema = z.object({
  providerMessageId: z.string().optional(),
  toAddress: z.string().email(),
  reason: z.string().max(1000).optional(),
  diagnosticCode: z.string().max(500).optional(),
  bouncedAt: z.string().datetime().optional(),
});
export type MailBounceReconcileInput = z.infer<typeof MailBounceReconcileSchema>;

export interface MailHealthMetrics {
  totalDispatches: number;
  accepted: number;
  delivered: number;
  bounced: number;
  failed: number;
  queued: number;
  sending: number;
  bounceRatePct: number;
  byTransport: Record<string, number>;
  byLane: Record<string, number>;
  dailyExternalQuota: {
    sentToday: number;
    limit: number;
    remaining: number;
  };
}



