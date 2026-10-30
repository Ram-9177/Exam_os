import type { ReactNode } from 'react';
import { cn } from './cn';
import { CheckIcon, CrossIcon, DotIcon, WarnIcon } from './icons';

export type Tone = 'neutral' | 'accent' | 'ready' | 'fix' | 'stop' | 'note';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-sheet-2 text-ink border-rule',
  accent: 'bg-accent-soft text-accent border-accent-soft',
  ready: 'bg-ready-soft text-ready border-ready-soft',
  fix: 'bg-fix-soft text-fix border-fix-soft',
  stop: 'bg-stop-soft text-stop border-stop-soft',
  note: 'bg-note-soft text-note border-note-soft',
};

/** A small, quiet label. Text always carries the meaning; tone only reinforces it. */
export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium leading-4 whitespace-nowrap', toneClass[tone], className)}>
      {children}
    </span>
  );
}

const toneIcon: Record<Tone, ReactNode> = {
  neutral: <DotIcon size={12} />,
  accent: <DotIcon size={12} />,
  ready: <CheckIcon size={12} />,
  fix: <WarnIcon size={12} />,
  stop: <CrossIcon size={12} />,
  note: <DotIcon size={12} />,
};

/** Status with an icon as well as text and colour, so colour is never the only carrier. */
export function StatusChip({ tone, children, className, icon = true, title }: { tone: Tone; children: ReactNode; className?: string; icon?: boolean; title?: string }) {
  return (
    <Badge tone={tone} className={cn('px-2 py-1 text-[13px] leading-4', className)} title={title}>
      {icon ? toneIcon[tone] : null}
      {children}
    </Badge>
  );
}

/** Maps API vocabularies to tones in one place. */
export function toneForAttempt(status: string | null | undefined): Tone {
  switch (status) {
    case 'ACTIVE':
    case 'READY':
    case 'ADMITTED':
      return 'ready';
    case 'SUSPENDED':
    case 'RECOVERY_PENDING':
      return 'fix';
    case 'VOIDED_BY_AUTHORITY':
    case 'EXPIRED':
      return 'stop';
    case 'SUBMITTED':
    case 'SUBMITTING':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function toneForExam(status: string | null | undefined): Tone {
  switch (status) {
    case 'LIVE':
      return 'accent';
    case 'PRECHECK':
    case 'SCHEDULED':
      return 'ready';
    case 'CANCELLED':
      return 'stop';
    case 'CLOSED':
    case 'ARCHIVED':
      return 'note';
    default:
      return 'neutral';
  }
}

export function toneForCandidate(status: string | null | undefined): Tone {
  switch (status) {
    case 'PUBLISHED':
      return 'accent';
    case 'CANDIDATE_APPROVED':
    case 'CONTROLLER_AUTHORIZED':
    case 'EXAM_CELL_REVIEW':
      return 'ready';
    case 'INTEGRITY_HOLD':
    case 'INVALIDATED_BY_AUTHORIZED_DECISION':
      return 'stop';
    case 'TECHNICAL_REVIEW_REQUIRED':
    case 'IDENTITY_REVIEW_REQUIRED':
    case 'MARKING_MODERATION_REQUIRED':
    case 'REVALUATION_PENDING':
      return 'fix';
    default:
      return 'neutral';
  }
}

export function toneForPrecheckItem(status: string | null | undefined): Tone {
  switch (status) {
    case 'PASS':
      return 'ready';
    case 'REMEDIATE':
      return 'fix';
    case 'NEED_HELP':
      return 'stop';
    case 'UNVERIFIABLE':
      return 'note';
    default:
      return 'neutral';
  }
}

/** Human wording for enum-style values: "PRECHECK_AVAILABLE" → "Precheck available". */
export function humanize(v: string | null | undefined): string {
  if (!v) return '—';
  const s = v.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
