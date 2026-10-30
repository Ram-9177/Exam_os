import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttemptStatus } from '@examos/contracts';
import { api, getDeviceSession, isApiError, setDeviceSession } from '@/lib/api';
import { syncFromResponse, type ClockSync } from '@/lib/time';

export const HEARTBEAT_MS = 20_000;
const QUIET = ['ATTEMPT_NOT_ACTIVE', 'DEVICE_SESSION_MISMATCH', 'DEADLINE_PASSED', 'ATTEMPT_STATE', 'EXAM_NOT_LIVE', 'NETWORK', 'ATTEMPT_NOT_FOUND'] as const;

export interface HeartbeatResponse {
  status: AttemptStatus;
  serverNow: string;
  deadlineAt: string | null;
  authorizationGeneration: number;
}
export interface ReconnectResponse {
  status: 'ACTIVE';
  deadlineAt: string;
  deviceSessionId: string;
  serverNow: string;
  answers: Array<{ questionId: string; serverRevision: number; contentSha256: string }>;
}

export type SessionKind = 'connecting' | 'active' | 'paused' | 'device-mismatch' | 'sealed' | 'expired' | 'offline' | 'error';

export interface AttemptSession {
  kind: SessionKind;
  status: AttemptStatus | null;
  deadlineAt: string | null;
  sync: ClockSync | null;
  /** Answers known to the server at reconnect time; used to detect stale local drafts. */
  serverAnswers: ReconnectResponse['answers'] | null;
  detail: string | null;
}

interface AdmitRecord {
  serverNow: string;
  deadlineAt: string;
  receivedAt: number;
}

function readAdmit(attemptId: string): AdmitRecord | null {
  try {
    const raw = sessionStorage.getItem(`examos.admit.${attemptId}`);
    return raw ? (JSON.parse(raw) as AdmitRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Owns the attempt's liveness: initial admit payload or reconnect, a heartbeat
 * every 20 s, and the server-derived clock. Status changes made by the
 * invigilator (SUSPENDED → ACTIVE) arrive through the heartbeat.
 */
export function useAttemptSession(attemptId: string, enabled = true) {
  const [session, setSession] = useState<AttemptSession>({ kind: 'connecting', status: null, deadlineAt: null, sync: null, serverAnswers: null, detail: null });
  const offlineSince = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // The one-time admit payload is consumed exactly once per attempt, even when React mounts the effect twice.
  const admitRef = useRef<{ attemptId: string; record: AdmitRecord } | null>(null);

  const applyStatus = useCallback((status: AttemptStatus, serverNow: string, deadlineAt: string | null, extra: Partial<AttemptSession> = {}) => {
    offlineSince.current = null;
    const sync = syncFromResponse(serverNow);
    setSession((s) => {
      let kind: SessionKind = s.kind;
      if (status === 'ACTIVE' || status === 'ADMITTED') kind = 'active';
      else if (status === 'SUSPENDED') kind = 'paused';
      else if (status === 'SUBMITTED' || status === 'SUBMITTING' || status === 'VOIDED_BY_AUTHORITY') kind = 'sealed';
      else if (status === 'EXPIRED') kind = 'expired';
      else if (status === 'RECOVERY_PENDING') kind = s.kind === 'active' ? 'active' : 'connecting';
      return { ...s, ...extra, kind, status, deadlineAt: deadlineAt ?? s.deadlineAt, sync, detail: null };
    });
  }, []);

  const reconnect = useCallback(async () => {
    try {
      const r = await api.post<ReconnectResponse>(`/student/attempts/${attemptId}/reconnect`, {}, { quiet: QUIET });
      setDeviceSession(r.deviceSessionId);
      applyStatus(r.status, r.serverNow, r.deadlineAt, { serverAnswers: r.answers });
      return true;
    } catch (e) {
      if (isApiError(e, 'DEVICE_SESSION_MISMATCH')) setSession((s) => ({ ...s, kind: 'device-mismatch', detail: e.problem.title }));
      else if (isApiError(e, 'DEADLINE_PASSED') || isApiError(e, 'EXAM_NOT_LIVE')) setSession((s) => ({ ...s, kind: 'expired', detail: e.problem.title }));
      else if (isApiError(e, 'ATTEMPT_STATE')) {
        // SUSPENDED / SUBMITTED etc. — the heartbeat tells us which.
        try {
          const hb = await api.post<HeartbeatResponse>(`/student/attempts/${attemptId}/heartbeat`, {}, { quiet: QUIET });
          applyStatus(hb.status, hb.serverNow, hb.deadlineAt);
        } catch {
          setSession((s) => ({ ...s, kind: 'error', detail: e.problem.title }));
        }
      } else if (isApiError(e, 'NETWORK')) setSession((s) => ({ ...s, kind: s.kind === 'connecting' ? 'offline' : s.kind }));
      else setSession((s) => ({ ...s, kind: 'error', detail: e instanceof Error ? e.message : 'Could not reconnect' }));
      return false;
    }
  }, [attemptId, applyStatus]);

  const heartbeat = useCallback(async () => {
    try {
      const hb = await api.post<HeartbeatResponse>(`/student/attempts/${attemptId}/heartbeat`, {}, { quiet: QUIET });
      if (hb.status === 'RECOVERY_PENDING') {
        await reconnect();
        return;
      }
      applyStatus(hb.status, hb.serverNow, hb.deadlineAt);
    } catch (e) {
      if (isApiError(e, 'DEVICE_SESSION_MISMATCH')) setSession((s) => ({ ...s, kind: 'device-mismatch', detail: e.problem.title }));
      else if (isApiError(e, 'NETWORK')) {
        offlineSince.current ??= Date.now();
        setSession((s) => (s.kind === 'active' || s.kind === 'offline' ? { ...s, kind: 'offline' } : s));
      }
    }
  }, [attemptId, applyStatus, reconnect]);

  useEffect(() => {
    if (!enabled || !attemptId) return;
    let cancelled = false;
    let admitRecord = admitRef.current?.attemptId === attemptId ? admitRef.current.record : null;
    if (!admitRecord) {
      admitRecord = readAdmit(attemptId);
      if (admitRecord) {
        admitRef.current = { attemptId, record: admitRecord };
        sessionStorage.removeItem(`examos.admit.${attemptId}`);
      }
    }
    if (admitRecord && getDeviceSession()) {
      setSession({ kind: 'active', status: 'ACTIVE', deadlineAt: admitRecord.deadlineAt, sync: { serverNowMs: Date.parse(admitRecord.serverNow), receivedAtMs: admitRecord.receivedAt }, serverAnswers: [], detail: null });
    } else {
      void reconnect().then((ok) => {
        if (!ok && !cancelled) void heartbeat();
      });
    }
    timer.current = setInterval(() => void heartbeat(), HEARTBEAT_MS);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [attemptId, enabled, reconnect, heartbeat]);

  return { session, reconnect, heartbeat };
}
