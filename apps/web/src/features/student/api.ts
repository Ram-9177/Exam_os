import { useQuery } from '@tanstack/react-query';
import type { AttemptStatus, ExamStatus, ExamType, IdCardVerificationData, SecurityProfile, StudentProfileData } from '@examos/contracts';
import { api } from '@/lib/api';

export function useStudentProfile() {
  return useQuery({
    queryKey: ['student', 'profile'],
    queryFn: () => api.get<{ profile: StudentProfileData }>('/student/profile'),
  });
}

export function useStudentIdCard() {
  return useQuery({
    queryKey: ['student', 'id-card'],
    queryFn: () => api.get<{ idCard: IdCardVerificationData & { qrDataUrl: string } }>('/student/profile/id-card'),
  });
}

export async function uploadStudentPhoto(input: { photoDataUrl: string; consentGiven: true }) {
  return api.post<{ sha256: string; byteLength: number; mimeType: string }>('/student/profile/photo', input);
}

export async function fetchPublicStudentVerification(hash: string) {
  return api.get<{ verification: IdCardVerificationData }>(`/student/verify-student/${hash}`);
}

export function getStudentSebConfigUrl(examId: string): string {
  return `/api/v1/student/me/exams/${examId}/seb-config`;
}

export async function requestStudentRevaluation(attemptId: string, input: { reason: string; feeRef?: string }) {
  return api.post<{ requestId: string; status: string }>(`/student/attempts/${attemptId}/revaluation`, input);
}

export interface StudentExam {
  examId: string;
  code: string;
  title: string;
  examType: ExamType;
  academicYear: string | null;
  semester: number | null;
  examStatus: ExamStatus;
  securityProfile: SecurityProfile;
  durationMinutes: number;
  windowStartAt: string;
  windowEndAt: string;
  courseCode: string | null;
  courseName: string | null;
  extraTimeMinutes: number;
  attemptId: string | null;
  attemptStatus: AttemptStatus | null;
  deadlineAt: string | null;
  hallTicketNumber: string | null;
  hallTicketVerification: string | null;
}

export interface LedgerRecord {
  exam_type: string;
  academic_year: string | null;
  semester: number | null;
  marks: string | number;
  max_marks: string | number;
  grade: string | null;
  hall_ticket_number: string | null;
  published_at: string;
  examCode: string;
  examTitle: string;
  courseCode: string | null;
  courseName: string | null;
  exam_id?: string;
  attempt_id?: string;
}
export interface LedgerSemester {
  academic_year: string | null;
  semester: number | null;
  exams: number | string;
  marks: number | string;
  max_marks: number | string;
  percentage: number | string | null;
}
export interface Ledger {
  records: LedgerRecord[];
  semesters: LedgerSemester[];
  overall: { exams: number | string; semesters: number | string; marks: number | string; max_marks: number | string; percentage: number | string | null };
}

export function useMyExams(refetchInterval?: number | false) {
  // Always fresh on mount: the status-driven action must reflect what the Examination Section just did.
  return useQuery({ queryKey: ['student', 'exams'], queryFn: () => api.get<{ exams: StudentExam[] }>('/student/me/exams'), refetchInterval: refetchInterval ?? false, staleTime: 0 });
}

export function useLedger() {
  return useQuery({ queryKey: ['student', 'ledger'], queryFn: () => api.get<Ledger>('/student/me/ledger') });
}

export interface AdmitResponse {
  attemptId: string;
  status: 'ACTIVE';
  serverNow: string;
  deadlineAt: string;
  authorizationGeneration: number;
  warningEpochId: string;
  deviceSessionId: string;
}

export const LOBBY_CODES = ['EXAM_NOT_STARTED', 'EXAM_NOT_LIVE', 'NOT_READY', 'PRECHECK_STALE', 'POLICY_CHANGED', 'ALREADY_ACTIVE', 'GRANT_INVALID'] as const;

export async function requestEntryGrant(attemptId: string): Promise<{ grantToken: string; expiresAt: string }> {
  return api.post<{ grantToken: string; expiresAt: string }>(`/student/attempts/${attemptId}/entry-grants`, {}, { quiet: LOBBY_CODES });
}

export async function admit(attemptId: string, grantToken: string): Promise<AdmitResponse> {
  return api.post<AdmitResponse>(`/student/attempts/${attemptId}/admit`, { grantToken }, { quiet: LOBBY_CODES });
}

export function numberOf(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const EXAM_TYPE_LABEL: Record<ExamType, string> = {
  MID_1: 'Mid-term 1',
  MID_2: 'Mid-term 2',
  SEM_INTERNAL: 'Semester internal',
  SEM_EXTERNAL: 'Semester external',
  SUPPLEMENTARY: 'Supplementary',
  PRACTICAL: 'Practical',
  VIVA: 'Viva',
  ASSIGNMENT: 'Assignment',
  OTHER: 'Other',
};
