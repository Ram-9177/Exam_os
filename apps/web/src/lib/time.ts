/**
 * Server-derived time. The browser clock is never trusted for deadlines: every
 * response that carries `serverNow` lets us estimate the offset between the
 * server clock and the local monotonic-ish clock, and the remaining time is
 * computed from `deadlineAt` through that offset.
 */
export interface ClockSync {
  /** serverNow (ms since epoch) as reported by the server. */
  serverNowMs: number;
  /** Local Date.now() at the moment the response was received. */
  receivedAtMs: number;
}

export function clockOffsetMs(sync: ClockSync): number {
  return sync.serverNowMs - sync.receivedAtMs;
}

/** Best estimate of the server's current time, in ms since epoch. */
export function estimatedServerNowMs(sync: ClockSync | null, localNowMs: number = Date.now()): number {
  return sync ? localNowMs + clockOffsetMs(sync) : localNowMs;
}

/** Remaining time until `deadlineAt` (ISO), never negative. */
export function remainingMs(deadlineAt: string | null | undefined, sync: ClockSync | null, localNowMs: number = Date.now()): number {
  if (!deadlineAt) return 0;
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - estimatedServerNowMs(sync, localNowMs));
}

export function syncFromResponse(serverNow: string, receivedAtMs: number = Date.now()): ClockSync {
  return { serverNowMs: Date.parse(serverNow), receivedAtMs };
}

/** "1:05:09" / "12:03" style clock readout for timers. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "1 hour 5 minutes" — for screen readers and announcements. */
export function formatDurationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (!h && !m) parts.push(`${s} ${s === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-IN', { timeZone, ...opts });
    } catch {
      f = new Intl.DateTimeFormat('en-IN', opts);
    }
    dtfCache.set(key, f);
  }
  return f;
}

/** Date + time in the tenant's timezone, e.g. "Mon, 3 Nov 2026, 10:00 am". */
export function formatDateTime(iso: string | null | undefined, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf(timeZone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

export function formatDate(iso: string | null | undefined, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf(timeZone, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

export function formatTime(iso: string | null | undefined, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf(timeZone, { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** A short relative phrase ("in 2 h 10 min", "3 min ago") for staff screens. */
export function formatRelative(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = t - nowMs;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  let phrase: string;
  if (min < 1) phrase = 'under a minute';
  else if (min < 60) phrase = `${min} min`;
  else if (min < 60 * 24) phrase = `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
  else phrase = `${Math.round(min / 60 / 24)} d`;
  return diff >= 0 ? `in ${phrase}` : `${phrase} ago`;
}
