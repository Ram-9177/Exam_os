import type { ProctorSignalClass } from '@examos/contracts';
import { api } from './api';
import { uuid } from './ids';

/**
 * Client-side proctoring signals (FOCUS_LOST, FULLSCREEN_EXIT). Signals are
 * context for a human, never a warning by themselves (spec §9). They are
 * rate-limited to one per class per 5 s so a single interruption never
 * becomes a flood, and each carries a stable uuid sourceEventId.
 */
export interface SignalReporterOptions {
  attemptId: string;
  minIntervalMs?: number;
  now?: () => number;
  send?: (events: SignalEvent[]) => Promise<unknown>;
}

export interface SignalEvent {
  sourceEventId: string;
  attemptId: string;
  signalClass: ProctorSignalClass;
  clientRecordedAt: string;
  clientSequence: number;
  metadata: Record<string, unknown>;
}

export class SignalReporter {
  private readonly lastSent = new Map<ProctorSignalClass, number>();
  private seq = 0;
  private readonly opts: Required<SignalReporterOptions>;

  constructor(options: SignalReporterOptions) {
    this.opts = {
      minIntervalMs: 5000,
      now: () => Date.now(),
      send: (events) => api.post('/proctor/events', { events }, { quiet: true }),
      ...options,
    };
  }

  /** Returns the event if it was sent, null if suppressed by the rate limit. */
  report(signalClass: ProctorSignalClass, metadata: Record<string, unknown> = {}): SignalEvent | null {
    const now = this.opts.now();
    const last = this.lastSent.get(signalClass);
    if (last !== undefined && now - last < this.opts.minIntervalMs) return null;
    this.lastSent.set(signalClass, now);
    const ev: SignalEvent = { sourceEventId: uuid(), attemptId: this.opts.attemptId, signalClass, clientRecordedAt: new Date(now).toISOString(), clientSequence: ++this.seq, metadata };
    void this.opts.send([ev]).catch(() => undefined);
    return ev;
  }
}
