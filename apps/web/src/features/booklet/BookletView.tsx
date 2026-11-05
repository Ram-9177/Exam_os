import { promptText } from '@examos/contracts';
import { useMemo, useState, type ReactNode } from 'react';
import { isCanvasContent, paragraphText, type AnswerDoc, type Block, type CanvasContent } from '@/lib/answers';
import { formatDateTime } from '@/lib/time';
import { cn } from '@/ui';
import { StrokesSvg } from '@/features/drawing/StrokesSvg';
import { EXAM_TYPE_LABEL } from '@/features/student/api';
import type { ExamType } from '@examos/contracts';

function examTypeLabel(t: string): string {
  return (EXAM_TYPE_LABEL as Record<string, string>)[t as ExamType] ?? t.replace(/_/g, ' ').toLowerCase();
}

export function parseAnswerBlocks(input: unknown): Block[] {
  if (!input) return [];
  let obj = input;
  if (typeof obj === 'string') {
    const trimmed = obj.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return [{ id: 'b-fallback', kind: 'paragraph', content: obj }];
      }
    } else {
      return [{ id: 'b-fallback', kind: 'paragraph', content: obj }];
    }
  }

  if (Array.isArray(obj)) {
    return obj.map((b, i) => normalizeSingleBlock(b, `b-${i}`));
  }

  if (typeof obj === 'object' && obj !== null) {
    const record = obj as Record<string, any>;
    if (Array.isArray(record.blocks)) {
      return record.blocks.map((b: any, i: number) => normalizeSingleBlock(b, `b-${i}`));
    }
    if (record.content && typeof record.content === 'object') {
      if (Array.isArray(record.content.blocks)) {
        return record.content.blocks.map((b: any, i: number) => normalizeSingleBlock(b, `b-${i}`));
      }
      if (Array.isArray(record.content.strokes)) {
        return [{ id: 'b-c0', kind: 'canvas', content: record.content }];
      }
    }
    if (Array.isArray(record.strokes)) {
      return [{ id: 'b-c0', kind: 'canvas', content: record }];
    }
    if (typeof record.text === 'string') {
      return [{ id: 'b-t0', kind: 'paragraph', content: record.text }];
    }
  }

  return [];
}

function normalizeSingleBlock(b: any, fallbackId: string): Block {
  if (!b || typeof b !== 'object') {
    return { id: fallbackId, kind: 'paragraph', content: String(b ?? '') };
  }
  const id = typeof b.id === 'string' && b.id ? b.id : fallbackId;
  const kind = typeof b.kind === 'string' ? b.kind : 'paragraph';
  let content = b.content !== undefined ? b.content : (b.value ?? b.text ?? null);
  if (typeof content === 'string' && (kind === 'canvas' || kind === 'drawing')) {
    try {
      content = JSON.parse(content);
    } catch {
      // keep
    }
  }
  return { id, kind: kind as any, content };
}

export function normalizeCanvasContent(content: unknown): CanvasContent | null {
  if (!content) return null;
  let c = content as any;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch {
      return null;
    }
  }
  if (!c || typeof c !== 'object') return null;
  if (!Array.isArray(c.strokes)) {
    if (c.content && Array.isArray(c.content.strokes)) {
      c = c.content;
    } else {
      return null;
    }
  }
  return {
    width: typeof c.width === 'number' && c.width > 0 ? c.width : 800,
    height: typeof c.height === 'number' && c.height > 0 ? c.height : 480,
    background: c.background || 'blank',
    strokes: c.strokes,
  };
}

export interface BookletQuestion {
  questionId: string;
  /** Prompt blocks as stored on the paper (a plain string from older data is accepted too). */
  prompt?: unknown;
  answer: AnswerDoc;
  answerSha256: string | null;
  revision: number;
  marks: number | null;
  maxMarks: number | null;
  explanation: string | null;
  criteria: Array<{ code: string; max: number; awarded: number; evidence?: string }> | null;
}
export interface Booklet {
  tenant: { name: string; slug: string };
  exam: { code: string; title: string; examType: string; academicYear: string | null; semester: number | null; durationMinutes: number };
  student: { name: string; registerNumber: string | null; hallTicket: string | null };
  status: string;
  sealedAt: string | null;
  manifestSha256: string | null;
  questions: BookletQuestion[];
  total: { marks: number; max: number; version: number } | null;
  validation: { examiner: string | null; examinerApprovedAt: string | null; controller: string | null; publishedAt: string | null };
  verificationHash: string;
  verificationUrl: string;
}

export function questionLabel(id: string, index: number): string {
  const m = /^Q(\d+)$/i.exec(id);
  return m ? `Question ${m[1]}` : `Question ${index + 1} (${id})`;
}

function BookletDiagram({ canvas, index }: { canvas: CanvasContent; index: number }) {
  const [paper, setPaper] = useState<CanvasContent['background']>(canvas.background || 'blank');
  const effectiveCanvas = useMemo(() => ({ ...canvas, background: paper }), [canvas, paper]);
  const strokeCount = canvas.strokes.filter((s) => s.tool !== 'eraser').length;

  return (
    <figure className="border border-rule-2 rounded-sm bg-sheet p-2.5 text-ink shadow-xs">
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-rule/50 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[11px] tracking-wider uppercase text-ink-2">Diagram {index}</span>
          <span className="text-[11px] text-ink-3">· {strokeCount} {strokeCount === 1 ? 'stroke' : 'strokes'}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-ink-3 mr-1">Paper:</span>
          <button
            type="button"
            onClick={() => setPaper('blank')}
            className={cn('px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer', paper === 'blank' || !paper ? 'bg-sheet-2 text-ink shadow-xs border border-rule-2' : 'text-ink-2 hover:text-ink')}
            title="Clean Paper (Plain)"
          >
            Clean
          </button>
          <button
            type="button"
            onClick={() => setPaper('grid')}
            className={cn('px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer', paper === 'grid' ? 'bg-sheet-2 text-ink shadow-xs border border-rule-2' : 'text-ink-2 hover:text-ink')}
            title="Subtle Engineering Grid"
          >
            Grid
          </button>
          <button
            type="button"
            onClick={() => setPaper('dots')}
            className={cn('px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer', paper === 'dots' ? 'bg-sheet-2 text-ink shadow-xs border border-rule-2' : 'text-ink-2 hover:text-ink')}
            title="Dot Grid"
          >
            Dots
          </button>
        </div>
      </div>
      <StrokesSvg content={effectiveCanvas} label={`Diagram ${index}`} />
      <figcaption className="text-xs text-ink-2 mt-1.5 flex items-center justify-between">
        <span>Diagram, drawn by the candidate</span>
        {canvas.background && canvas.background !== 'blank' ? (
          <span className="text-[11px] text-ink-3">Authored on {canvas.background} paper</span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** The answer rendered as it was written: paragraphs on ruled paper, diagrams from their strokes, equations and code. */
export function AnswerRender({ doc, className }: { doc: AnswerDoc | unknown; className?: string }) {
  const blocks = parseAnswerBlocks(doc);

  const hasContent = blocks.some((b) => {
    if (b.kind === 'paragraph') return typeof b.content === 'string' && b.content.trim().length > 0;
    if ((b.kind as string) === 'choice') return true;
    if (b.kind === 'canvas' || (b.kind as string) === 'drawing') {
      const c = normalizeCanvasContent(b.content);
      return c !== null && c.strokes.length > 0;
    }
    return b.content != null && b.content !== '';
  });

  if (!hasContent) {
    return <p className={cn('ruled ruled-inset text-ink-3 italic min-h-16 flex items-center', className)}>No answer was written.</p>;
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {blocks.map((b, i) => {
        const isCanvas = b.kind === 'canvas' || (b.kind as string) === 'drawing' || (b.content && typeof b.content === 'object' && 'strokes' in (b.content as any));
        if (isCanvas) {
          const canvas = normalizeCanvasContent(b.content);
          if (canvas) {
            return <BookletDiagram key={b.id || `canvas-${i}`} canvas={canvas} index={i + 1} />;
          }
        }

        if ((b.kind as string) === 'choice') {
          return <p key={b.id} className="font-medium">Selected option: {String((b.content as { selected?: unknown } | null)?.selected ?? '—')}</p>;
        }
        if (b.kind === 'equation' || (b.kind as string) === 'formula') {
          const formulaText = typeof b.content === 'string' ? b.content : (b.content as any)?.formula || (b.content as any)?.latex || JSON.stringify(b.content);
          return (
            <div key={b.id || `eq-${i}`} className="my-2 p-3 bg-sheet-2 border border-rule-2 rounded-sm text-center">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-1">Mathematical Formula</div>
              <div className="font-mono text-base text-ink font-medium tracking-wide py-1 px-3 bg-sheet rounded inline-block border border-rule max-w-full overflow-x-auto">
                {formulaText}
              </div>
            </div>
          );
        }

        if ((b.kind as string) === 'code') {
          const codeText = typeof b.content === 'string' ? b.content : (b.content as any)?.code || JSON.stringify(b.content, null, 2);
          return (
            <div key={b.id || `code-${i}`} className="my-2 p-3 bg-sheet-2 border border-rule-2 rounded-sm font-mono text-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-1">Code Solution</div>
              <pre className="overflow-x-auto p-2 bg-sheet rounded border border-rule whitespace-pre text-ink text-xs sm:text-sm">
                <code>{codeText}</code>
              </pre>
            </div>
          );
        }

        const text = typeof b.content === 'string' ? b.content : paragraphText(b) || (b.content != null ? String(b.content) : '');
        return (
          <div key={b.id || `p-${i}`} className="ruled ruled-inset whitespace-pre-wrap text-[16px] min-h-16">
            {text || ' '}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The digital answer booklet: on screen a sheet of A4 proportion; in print a
 * real booklet with a page per question and booklet margins. `marks` lets the
 * marking screen replace the read-only marks block with inputs.
 */
export function BookletView({ booklet, tz, marks, headerActions }: { booklet: Booklet; tz: string; marks?: (q: BookletQuestion, index: number) => ReactNode; headerActions?: ReactNode }) {
  const b = booklet;
  return (
    <article className="booklet mx-auto w-full max-w-[210mm] bg-sheet border border-rule-2 text-ink" aria-label="Digital answer booklet">
      <header className="booklet-cover px-10 pt-10 pb-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="font-serif text-3xl" style={{ fontVariationSettings: "'opsz' 72" }}>
              {b.tenant.name}
            </p>
            <p className="text-ink-2 mt-1">Digital answer booklet</p>
          </div>
          {headerActions ? <div className="no-print flex gap-2">{headerActions}</div> : null}
        </div>

        <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-px bg-rule-2 border border-rule-2">
          <Box label="Name" value={b.student.name} />
          <Box label="Register number" value={b.student.registerNumber ?? '—'} mono />
          <Box label="Hall ticket" value={b.student.hallTicket ?? '—'} mono />
        </div>
        <div className="mt-px grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule-2 border border-rule-2 border-t-0">
          <Box label="Exam" value={`${b.exam.title}`} />
          <Box label="Code" value={b.exam.code} mono />
          <Box label="Type" value={examTypeLabel(b.exam.examType)} />
          <Box label="Term" value={`${b.exam.academicYear ?? '—'}${b.exam.semester ? ` · Sem ${b.exam.semester}` : ''}`} />
        </div>
        <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-ink-2">Sealed</dt>
          <dd>{formatDateTime(b.sealedAt, tz)}</dd>
          <dt className="text-ink-2">Submission manifest</dt>
          <dd className="font-mono text-xs break-all">{b.manifestSha256 ?? '—'}</dd>
          <dt className="text-ink-2">Status</dt>
          <dd>{b.status.replace(/_/g, ' ').toLowerCase()}</dd>
        </dl>
      </header>

      {b.questions.map((q, i) => (
        <section key={q.questionId} className="booklet-question px-10 py-8 border-t border-rule" aria-labelledby={`bq-${q.questionId}`}>
          <div className="flex items-start justify-between gap-6 mb-4">
            <h2 id={`bq-${q.questionId}`} className="text-h3">
              {questionLabel(q.questionId, i)}
            </h2>
            {marks ? null : (
              <div className="shrink-0 border border-ink rounded-sm px-3 py-1.5 text-center min-w-24">
                <p className="text-xs text-ink-2">Marks</p>
                <p className="font-mono tabular text-xl">
                  {q.marks ?? '—'} <span className="text-ink-2 text-sm">/ {q.maxMarks ?? '—'}</span>
                </p>
              </div>
            )}
          </div>
          {promptText(q.prompt) ? (
            <div className="mb-4 p-3.5 bg-sheet-2 border border-rule-2 rounded text-[15px] leading-relaxed whitespace-pre-wrap">
              <span className="block text-xs font-semibold text-ink-2 uppercase tracking-wider mb-1">Question Prompt</span>
              {promptText(q.prompt)}
            </div>
          ) : null}
          <AnswerRender doc={q.answer} />
          {marks ? (
            <div className="mt-6">{marks(q, i)}</div>
          ) : (
            <>
              <div className="mt-6 border border-rule-2 rounded-sm p-4 bg-sheet-2">
                <p className="text-sm font-medium">Marks explanation</p>
                <p className="mt-1 whitespace-pre-wrap">{q.explanation ?? 'Not yet marked.'}</p>
              </div>
              {q.criteria && q.criteria.length > 0 ? (
                <table className="mt-4 w-full text-sm">
                  <caption className="visually-hidden">Criteria</caption>
                  <thead>
                    <tr className="border-b border-rule-2 text-left text-ink-2">
                      <th scope="col" className="py-1 pr-3 font-medium">
                        Criterion
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium text-right">
                        Awarded
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Evidence
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.criteria.map((c) => (
                      <tr key={c.code} className="border-b border-rule">
                        <td className="py-1 pr-3">{c.code}</td>
                        <td className="py-1 pr-3 text-right font-mono tabular">
                          {c.awarded} / {c.max}
                        </td>
                        <td className="py-1 text-ink-2">{c.evidence ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </>
          )}
          <p className="mt-4 text-xs text-ink-3 font-mono break-all">
            revision {q.revision} · {q.answerSha256 ?? 'no answer document'}
          </p>
        </section>
      ))}

      <footer className="booklet-end px-10 py-8 border-t border-rule">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm text-ink-2">Total</p>
            <p className="font-serif text-5xl tabular leading-none mt-1" style={{ fontVariationSettings: "'opsz' 72" }}>
              {b.total ? `${b.total.marks}` : '—'}
              <span className="text-2xl text-ink-2"> / {b.total ? b.total.max : '—'}</span>
            </p>
            {b.total ? <p className="text-sm text-ink-2 mt-1">Result version {b.total.version}</p> : null}
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-ink-2">Marked by (examiner)</dt>
            <dd>{b.validation.examiner ?? '—'}{b.validation.examinerApprovedAt ? `, ${formatDateTime(b.validation.examinerApprovedAt, tz)}` : ''}</dd>
            <dt className="text-ink-2">Authorised by (Controller)</dt>
            <dd>{b.validation.controller ?? '—'}</dd>
            <dt className="text-ink-2">Published</dt>
            <dd>{formatDateTime(b.validation.publishedAt, tz)}</dd>
          </dl>
        </div>
        <div className="mt-8 pt-4 border-t border-rule text-xs text-ink-2">
          <p>
            Verification hash <span className="font-mono break-all text-ink">{b.verificationHash}</span>
          </p>
          <p className="mt-1">
            Verify at <span className="font-mono text-ink">{typeof window !== 'undefined' ? `${window.location.origin}${b.verificationUrl}` : b.verificationUrl}</span>
          </p>
        </div>
      </footer>
    </article>
  );
}

function Box({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-sheet px-3 py-2">
      <p className="text-xs text-ink-2">{label}</p>
      <p className={cn('mt-0.5 break-words', mono && 'font-mono tabular')}>{value}</p>
    </div>
  );
}
