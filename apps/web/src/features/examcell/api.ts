import { useQuery } from '@tanstack/react-query';
import type { AttemptStatus, CandidateStatus, ExamClientPolicyUpdate, ExamStatus, ExamType, PrecheckCheckCode, PrecheckItemStatus, PrecheckStatus, SebConfigGenerateInput, SebConfigResult, SecurityProfile, SuspensionKind } from '@examos/contracts';
import { api } from '@/lib/api';

export interface ExamListItem {
  id: string;
  code: string;
  title: string;
  status: ExamStatus;
  examType: ExamType;
  academicYear: string | null;
  semester: number | null;
  securityProfile: SecurityProfile;
  durationMinutes: number;
  windowStartAt: string;
  windowEndAt: string;
  courseCode: string | null;
  courseName: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  schoolCode: string | null;
  schoolName: string | null;
}

/** Raw exam row as returned by GET /exams/:id (database column names). */
export interface ExamRow {
  id: string;
  /** Set when the Controller of Examinations released this exam's results (all at once). */
  results_published_at?: string | null;
  code: string;
  title: string;
  status: ExamStatus;
  exam_type: ExamType;
  academic_year: string | null;
  semester: number | null;
  max_marks: string | number | null;
  security_profile: SecurityProfile;
  duration_minutes: number;
  window_start_at: string;
  window_end_at: string;
  warning_threshold: number;
  policy: Record<string, unknown>;
  policy_version: string;
  precheck_opened_at: string | null;
  started_at: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface ExamFilters {
  status?: string;
  examType?: string;
  academicYear?: string;
  semester?: string;
  departmentCode?: string;
  schoolCode?: string;
  q?: string;
}

function qs(f: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useExams(filters: ExamFilters) {
  return useQuery({ queryKey: ['exams', filters], queryFn: () => api.get<{ exams: ExamListItem[] }>(`/exams${qs(filters as Record<string, string | undefined>)}`) });
}

export function useExam(id: string) {
  return useQuery({ queryKey: ['exam', id], queryFn: () => api.get<{ exam: ExamRow; attemptCounts: Record<string, number> }>(`/exams/${id}`), enabled: !!id });
}

export type ExamAction = 'submit-for-review' | 'approve' | 'schedule' | 'open-precheck' | 'start' | 'close' | 'archive' | 'cancel';

export function transitionExam(id: string, action: ExamAction) {
  return api.post<{ from: ExamStatus; to: ExamStatus }>(`/exams/${id}/${action}`, {}, { quiet: ['OUTSIDE_WINDOW', 'ILLEGAL_TRANSITION'] });
}

export interface ReadinessCandidate {
  attemptId: string;
  status: AttemptStatus;
  suspensionKind: SuspensionKind | null;
  fullName: string;
  email: string;
  registerNumber: string | null;
  hallTicket: string | null;
  precheck: { runId: string; status: PrecheckStatus; clientBuild: string | null; startedAt: string; readyUntil: string | null } | null;
  checks: Array<{ code: PrecheckCheckCode; status: PrecheckItemStatus; source: string; diagnosticCode: string | null; remediationCode: string | null; instruction: string; securityRelevant: boolean }>;
  blocking: PrecheckCheckCode[];
  exceptions: Array<{ id: string; code: string; coversChecks: PrecheckCheckCode[]; approvedBy: string; expiresAt: string }>;
}
export interface ReadinessBoard {
  exam: { id: string; code: string; title: string; status: ExamStatus; securityProfile: SecurityProfile; startedAt: string | null; precheckOpenedAt: string | null };
  summary: { total: number; ready: number; needsFix: number; needsReview: number; notStarted: number; active: number; suspended: number; submitted: number };
  candidates: ReadinessCandidate[];
}

export function useReadinessBoard(examId: string, enabled: boolean) {
  return useQuery({ queryKey: ['exam', examId, 'readiness'], queryFn: () => api.get<ReadinessBoard>(`/exams/${examId}/readiness`), enabled: enabled && !!examId, refetchInterval: 10_000 });
}

export interface PaperQuestion {
  id?: string;
  questionId: string;
  sectionCode: string;
  number: number;
  kind: 'DESCRIPTIVE' | 'MCQ' | 'NUMERIC' | 'DRAWING';
  prompt: { blocks: Array<{ id?: string; kind: string; content: unknown }> };
  options?: Array<{ key: string; text: string }>;
  maxMarks: number;
  rubric?: Array<{ code: string; max: number; description: string; difficulty?: number; keywords?: string[] }>;
  expectedAnswer?: unknown;
  attachments?: unknown[];
}

export interface PaperSection {
  code: string;
  title: string;
  instructions?: string;
}

export interface QuestionPaper {
  id: string;
  examId: string;
  version: number;
  status: 'DRAFT' | 'REVIEW' | 'APPROVED' | 'SUPERSEDED';
  title: string;
  instructions: string | null;
  totalMarks: number;
  sections: PaperSection[];
  sealedSha256: string | null;
  createdBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  questions: PaperQuestion[];
  sets: Array<{ setCode: string; questionOrder: string[] }>;
}

export function useExamPaper(examId: string, enabled = true) {
  return useQuery({
    queryKey: ['exam', examId, 'paper'],
    queryFn: () => api.get<{ paper: QuestionPaper }>(`/exams/${examId}/paper`),
    enabled: enabled && !!examId,
  });
}

export interface CandidateRow {
  id: string;
  attempt_id: string;
  status: CandidateStatus;
  version: number;
  result_version_id: string | null;
  academic_state: string;
  identity_state: string;
  integrity_state: string;
  media_quality_state: string;
  hold_reason: string | null;
  fullName: string;
  registerNumber: string | null;
  hallTicket: string | null;
  resultVersion: number | null;
  totalMarks: string | number | null;
  maxMarks: string | number | null;
  published_at: string | null;
}
export interface CandidatesResponse {
  summary: { total: number; ready: number; approved: number; published: number; needsReview: number; onHold: number; awaitingMarks: number };
  candidates: CandidateRow[];
}

export function useCandidates(examId: string, enabled: boolean) {
  return useQuery({ queryKey: ['exam', examId, 'candidates'], queryFn: () => api.get<CandidatesResponse>(`/exams/${examId}/candidates`), enabled: enabled && !!examId });
}

export interface Checklist {
  packet: CandidateRow & { exam_id: string; user_id: string; sealed_submission_verified: boolean; checklist_digest: string | null };
  exam: { id: string; code: string; title: string; examType: ExamType };
  resultVersion: { id: string; version: number; total_marks: string | number; max_marks: string | number; approved_by: string | null; approved_at: string | null } | null;
  checks: Array<{ code: string; ok: boolean; detail: string }>;
  publishable: boolean;
  /** The current Exam Cell approval, when one exists; what the Controller publishes. */
  liveApproval: { id: string; approverUserId: string; resultVersionId: string; createdAt: string } | null;
}

export function useChecklist(attemptId: string | null) {
  return useQuery({ queryKey: ['candidate', attemptId, 'checklist'], queryFn: () => api.get<Checklist>(`/candidates/${attemptId}/checklist`, { quiet: ['PACKET_NOT_FOUND'] }), enabled: !!attemptId });
}

export const EXAM_STATUS_LABEL: Record<ExamStatus, string> = {
  DRAFT: 'Draft',
  PAPER_REVIEW: 'Paper review',
  APPROVED: 'Approved',
  SCHEDULED: 'Scheduled',
  PRECHECK: 'Readiness open',
  LIVE: 'Live',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
  CANCELLED: 'Cancelled',
};

export const CHECK_SHORT: Record<PrecheckCheckCode, string> = {
  IDENTITY_SESSION: 'ID',
  ELIGIBILITY: 'Elig',
  CLIENT_VERSION: 'Client',
  NETWORK_SAVE_ROUNDTRIP: 'Net',
  CLOCK_SYNC: 'Clock',
  KEYBOARD_INPUT: 'Keys',
  CANVAS_INPUT: 'Draw',
  CAMERA: 'Cam',
  MICROPHONE: 'Mic',
  CONSENT: 'Consent',
  SYSTEM_SCAN: 'Scan',
};

export async function generateSebConfig(examId: string, options?: SebConfigGenerateInput) {
  return api.post<SebConfigResult>(`/exams/${examId}/seb-config`, options ?? {});
}

export async function updateClientPolicy(examId: string, policy: ExamClientPolicyUpdate) {
  return api.put<{ policy: Record<string, unknown> }>(`/exams/${examId}/client-policy`, policy);
}


