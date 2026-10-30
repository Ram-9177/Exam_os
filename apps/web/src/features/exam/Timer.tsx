import { useEffect, useRef, useState } from 'react';
import { formatClock, formatDurationWords, remainingMs, type ClockSync } from '@/lib/time';
import { cn } from '@/ui';

/**
 * The invigilator's clock: server-derived remaining time, large and tabular.
 * Announced politely every minute and at 5 and 1 minutes; the last five minutes
 * change tone (with text), never the layout.
 */
export function Timer({ deadlineAt, sync, onExpired, className }: { deadlineAt: string | null; sync: ClockSync | null; onExpired?: () => void; className?: string }) {
  const [ms, setMs] = useState(() => remainingMs(deadlineAt, sync));
  const [announcement, setAnnouncement] = useState('');
  const lastMinute = useRef<number | null>(null);
  const expiredFired = useRef(false);
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    // A new deadline (extension) re-arms the callback; a mere clock re-sync does not.
    if (firedFor.current !== deadlineAt) {
      expiredFired.current = false;
      firedFor.current = deadlineAt;
    }
    const tick = () => {
      const left = remainingMs(deadlineAt, sync);
      setMs(left);
      const minute = Math.ceil(left / 60_000);
      if (lastMinute.current !== minute) {
        const first = lastMinute.current === null;
        lastMinute.current = minute;
        if (!first || minute <= 5) setAnnouncement(left <= 0 ? 'Time is over. Your answers are being sealed.' : `${formatDurationWords(left)} remaining`);
      }
      if (left <= 0 && !expiredFired.current && deadlineAt) {
        expiredFired.current = true;
        onExpired?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadlineAt, sync, onExpired]);

  const lastFive = ms > 0 && ms <= 5 * 60_000;
  const lastOne = ms > 0 && ms <= 60_000;
  return (
    <div className={cn('flex items-baseline gap-3', className)}>
      <span className={cn('font-mono tabular text-3xl leading-none', lastFive ? 'text-fix' : 'text-accent')} aria-hidden="true">
        {deadlineAt ? formatClock(ms) : '--:--'}
      </span>
      <span className="text-sm text-ink-2">{!deadlineAt ? 'time not started' : ms <= 0 ? 'time over' : lastOne ? 'under a minute left' : lastFive ? `${Math.ceil(ms / 60_000)} min left` : 'remaining'}</span>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}
