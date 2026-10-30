import type { ProctorSignalClass } from '@examos/contracts';

/** One recorded signal as the timeline returns it. Metadata is client context (or server context for server classes). */
export interface SignalRow {
  id: string;
  incident_id: string | null;
  signal_class: ProctorSignalClass;
  source_id: string;
  metadata: Record<string, unknown> | null;
  client_recorded_at: string | null;
  server_received_at: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

/** "4 s", "1 min 12 s", "12 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return m >= 10 || rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

function display(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const w = num(d['width']);
  const h = num(d['height']);
  if (w === null || h === null) return null;
  const dpr = num(d['pixelRatio']);
  const parts = [`${w}×${h}`];
  if (dpr !== null && dpr !== 1) parts.push(`@${dpr}x`);
  if (d['extended'] === true) parts.push('extended desktop');
  const screens = num(d['screens']);
  if (screens !== null) parts.push(`${screens} ${screens === 1 ? 'screen' : 'screens'}`);
  return parts.join(' ');
}

/**
 * Plain-language description of what a signal says, for the person deciding. It repeats what was reported and
 * says who reported it; it never concludes anything.
 */
export function describeSignal(row: Pick<SignalRow, 'signal_class' | 'metadata' | 'source_id'>): string {
  const m = row.metadata ?? {};
  const by = row.source_id.startsWith('SERVER') ? 'Observed by the server' : 'Reported by the student’s browser';
  switch (row.signal_class) {
    case 'FOCUS_LOST': {
      const where = m['reason'] === 'tab-hidden' ? 'The exam tab was hidden (another tab, minimised or the screen locked)' : 'Another window or app took focus';
      const away = num(m['awayMs']);
      if (m['phase'] === 'returned') return `${by}: returned to the exam after ${away !== null ? formatDuration(away) : 'an unknown time'} away. ${where}.`;
      return `${by}: left the exam. ${where}.`;
    }
    case 'FULLSCREEN_EXIT': {
      const outside = num(m['outsideMs']);
      if (m['phase'] === 'restored') return `${by}: back in full screen after ${outside !== null ? formatDuration(outside) : 'an unknown time'}.`;
      if (m['phase'] === 'refused') return `${by}: full screen could not be entered on this device; the student continued without it.`;
      return `${by}: left full screen. The paper is hidden until full screen is restored.`;
    }
    case 'DUAL_SCREEN_DETECTED': {
      const screens = num(m['screens']);
      return `${by}: ${screens !== null && screens > 1 ? `${screens} screens are connected` : 'the desktop extends onto a second screen'}.`;
    }
    case 'DISPLAY_CHANGED': {
      const from = display(m['from']);
      const to = display(m['to']);
      return `${by}: the display changed${from && to ? ` from ${from} to ${to}` : ''}. A projector, mirroring or a new monitor can cause this; so can browser zoom.`;
    }
    case 'MULTIPLE_TABS':
      return `${by}: the exam was open in ${num(m['tabs']) ?? 2} tabs or windows at once.`;
    case 'WINDOW_RESIZED':
      return `${by}: the exam window was made smaller than the screen${str(m['outer']) && str(m['avail']) ? ` (${m['outer']} on a ${m['avail']} screen)` : ''}, as in split-screen.`;
    case 'CLIPBOARD_ATTEMPT':
      return `${by}: tried to paste ${num(m['chars']) ?? 'some'} characters copied outside the exam. The paste was refused.`;
    case 'SCREEN_CAPTURE_ATTEMPT':
      return m['kind'] === 'print' ? `${by}: tried to print the exam. Printing is blocked.` : `${by}: pressed the PrintScreen key.`;
    case 'DEVTOOLS_ATTEMPT':
      return `${by}: pressed ${str(m['key']) ?? 'a developer-tools shortcut'}. It was blocked.`;
    case 'FACE_NOT_VISIBLE': {
      const secs = num(m['seconds']);
      const why = m['reason'] === 'covered' ? 'the camera view was dark or covered' : 'no face was in view';
      return `${by}: ${why}${secs !== null ? ` for ${formatDuration(secs * 1000)}` : ''}. Detected on the student’s device; no image was sent.`;
    }
    case 'MULTIPLE_PERSON_POSSIBLE':
      return `${by}: ${num(m['faces']) ?? 'more than one'} faces were in view${num(m['seconds']) !== null ? ` for ${formatDuration(num(m['seconds'])! * 1000)}` : ''}. Detected on the student’s device; no image was sent.`;
    case 'CAMERA_UNAVAILABLE':
      return `${by}: the camera stopped or is not available${str(m['reason']) ? ` (${m['reason']})` : ''}. Technical; never countable.`;
    case 'SECURE_CLIENT_MISSING':
      return `${by}: a request for this Safe Exam Browser exam arrived without a valid SEB key${str(m['route']) ? ` (${m['route']})` : ''}.`;
    case 'CONCURRENT_SESSION':
      return `${by}: the exam was used from a second device session.`;
    case 'NETWORK_ADDRESS_CHANGED':
      return `${by}: the attempt was reached from a new network address${str(m['ip']) ? ` (${m['ip']})` : ''}.`;
    default:
      return `${by}.`;
  }
}
