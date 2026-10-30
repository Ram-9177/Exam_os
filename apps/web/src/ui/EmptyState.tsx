import type { ReactNode } from 'react';
import { cn } from './cn';

/** An empty screen is an invitation to act: say what is missing and what to do next. */
export function EmptyState({ title, children, action, className }: { title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('sheet px-6 py-10 text-center', className)}>
      <p className="font-serif text-h3 text-ink">{title}</p>
      {children ? <div className="mt-2 text-ink-2 max-w-prose mx-auto">{children}</div> : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className, lines = 1 }: { className?: string; lines?: number }) {
  return (
    <div role="status" aria-label="Loading" className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 rounded-sm bg-sheet-2 animate-pulse" style={{ width: `${100 - (i % 3) * 12}%` }} />
      ))}
    </div>
  );
}

export function Stamp({ tone, children, className }: { tone: 'ready' | 'fix' | 'stop' | 'accent' | 'note'; children: ReactNode; className?: string }) {
  const color = { ready: 'text-ready', fix: 'text-fix', stop: 'text-stop', accent: 'text-accent', note: 'text-note' }[tone];
  return <span className={cn('stamp text-2xl', color, className)}>{children}</span>;
}

export function KeyValue({ items, className }: { items: Array<{ k: ReactNode; v: ReactNode; mono?: boolean }>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[15px]', className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-ink-2">{it.k}</dt>
          <dd className={cn('min-w-0 break-words', it.mono && 'font-mono text-sm')}>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PageTitle({ title, lede, actions, kicker }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; kicker?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
      <div className="min-w-0">
        {kicker ? <p className="text-ink-2 mb-1">{kicker}</p> : null}
        <h1 className="text-h1">{title}</h1>
        {lede ? <p className="mt-2 text-ink-2 max-w-prose">{lede}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}
