import type { ProctorSignalClass } from '@examos/contracts';

/**
 * Turns per-second camera observations (how many faces the on-device detector saw, how bright the frame is) into
 * signals for a human. Thresholds are deliberately forgiving — looking down at the keyboard or reaching for water is
 * not a signal; a sustained absence, a covered camera or a second face is. Every emission is context, never a verdict.
 */
export interface PresenceObservation {
  at: number;
  faces: number;
  /** Mean frame brightness 0..1; below COVERED_LUMINANCE the camera is treated as covered or blacked out. */
  luminance: number;
}
export interface PresenceEmission {
  signal: ProctorSignalClass;
  metadata: Record<string, unknown>;
  /** The closing half of an episode already reported (carries its duration); bypasses the reporter's rate limit. */
  force?: boolean;
}

export const ABSENT_AFTER_MS = 8_000;
export const MULTIPLE_AFTER_MS = 3_000;
export const COVERED_LUMINANCE = 0.06;

export class PresenceTracker {
  private absentSince: number | null = null;
  private absentReason: 'no-face' | 'covered' = 'no-face';
  private absentReported = false;
  private multiSince: number | null = null;
  private multiReported = false;
  private maxFaces = 0;

  observe(o: PresenceObservation): PresenceEmission[] {
    const out: PresenceEmission[] = [];
    const covered = o.luminance < COVERED_LUMINANCE;
    const absent = covered || o.faces === 0;

    if (absent) {
      if (this.absentSince === null) {
        this.absentSince = o.at;
        this.absentReason = covered ? 'covered' : 'no-face';
      } else if (covered) this.absentReason = 'covered';
      const ms = o.at - this.absentSince;
      if (!this.absentReported && ms >= ABSENT_AFTER_MS) {
        this.absentReported = true;
        out.push({ signal: 'FACE_NOT_VISIBLE', metadata: { phase: 'started', reason: this.absentReason, seconds: Math.round(ms / 1000) } });
      }
    } else if (this.absentSince !== null) {
      if (this.absentReported) out.push({ signal: 'FACE_NOT_VISIBLE', metadata: { phase: 'returned', reason: this.absentReason, seconds: Math.round((o.at - this.absentSince) / 1000) }, force: true });
      this.absentSince = null;
      this.absentReported = false;
    }

    if (!covered && o.faces >= 2) {
      this.multiSince ??= o.at;
      this.maxFaces = Math.max(this.maxFaces, o.faces);
      const ms = o.at - this.multiSince;
      if (!this.multiReported && ms >= MULTIPLE_AFTER_MS) {
        this.multiReported = true;
        out.push({ signal: 'MULTIPLE_PERSON_POSSIBLE', metadata: { faces: this.maxFaces, seconds: Math.round(ms / 1000) } });
      }
    } else {
      this.multiSince = null;
      this.multiReported = false;
      this.maxFaces = 0;
    }
    return out;
  }
}
