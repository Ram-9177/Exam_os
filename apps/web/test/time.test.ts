import { describe, expect, it } from 'vitest';
import { clockOffsetMs, estimatedServerNowMs, formatClock, formatDurationWords, remainingMs, syncFromResponse } from '@/lib/time';

describe('remaining time from the serverNow offset', () => {
  const deadline = '2026-11-03T10:00:00.000Z';

  it('uses the server clock, not the local one, when they disagree', () => {
    // Local clock is 10 minutes fast: at local 09:40 the server says 09:30.
    const sync = { serverNowMs: Date.parse('2026-11-03T09:30:00.000Z'), receivedAtMs: Date.parse('2026-11-03T09:40:00.000Z') };
    expect(clockOffsetMs(sync)).toBe(-10 * 60_000);
    const localNow = Date.parse('2026-11-03T09:45:00.000Z'); // 5 local minutes later → server 09:35
    expect(estimatedServerNowMs(sync, localNow)).toBe(Date.parse('2026-11-03T09:35:00.000Z'));
    expect(remainingMs(deadline, sync, localNow)).toBe(25 * 60_000);
  });

  it('counts down as local time advances', () => {
    const sync = syncFromResponse('2026-11-03T09:00:00.000Z', Date.parse('2026-11-03T09:00:00.000Z'));
    expect(remainingMs(deadline, sync, Date.parse('2026-11-03T09:00:00.000Z'))).toBe(3600_000);
    expect(remainingMs(deadline, sync, Date.parse('2026-11-03T09:59:30.000Z'))).toBe(30_000);
  });

  it('never goes negative and treats a missing deadline as zero', () => {
    const sync = syncFromResponse('2026-11-03T11:00:00.000Z', Date.parse('2026-11-03T11:00:00.000Z'));
    expect(remainingMs(deadline, sync, Date.parse('2026-11-03T11:00:01.000Z'))).toBe(0);
    expect(remainingMs(null, sync)).toBe(0);
    expect(remainingMs('garbage', sync)).toBe(0);
  });

  it('falls back to the local clock before the first sync', () => {
    const localNow = Date.parse('2026-11-03T09:50:00.000Z');
    expect(remainingMs(deadline, null, localNow)).toBe(10 * 60_000);
  });
});

describe('formatting', () => {
  it('formats a clock readout with hours only when needed', () => {
    expect(formatClock(3661_000)).toBe('1:01:01');
    expect(formatClock(59_000)).toBe('00:59');
    expect(formatClock(0)).toBe('00:00');
  });
  it('words for announcements', () => {
    expect(formatDurationWords(65 * 60_000)).toBe('1 hour 5 minutes');
    expect(formatDurationWords(60_000)).toBe('1 minute');
    expect(formatDurationWords(30_000)).toBe('30 seconds');
  });
});
