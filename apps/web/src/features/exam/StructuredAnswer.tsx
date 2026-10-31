import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, isApiError } from '@/lib/api';
import type { AnswerDoc, Block, CodeLanguageId } from '@/lib/answers';
import { uuid } from '@/lib/ids';
import { Button, cn } from '@/ui';

export interface CodeSpec {
  languages: CodeLanguageId[];
  starter?: Partial<Record<CodeLanguageId, string>>;
  samples?: Array<{ input: string; expected: string }>;
  timeLimitMs?: number;
  memoryMb?: number;
  sampleRunsAllowed?: number;
}
export interface StructuredQuestion {
  id: string;
  kind?: string;
  options?: unknown;
  codeSpec?: CodeSpec;
}

const LANGUAGE_LABEL: Record<CodeLanguageId, string> = { c: 'C', cpp: 'C++', java: 'Java', python: 'Python 3' };

function blockOf(doc: AnswerDoc, kind: Block['kind']): Block | undefined {
  return doc.blocks.find((b) => b.kind === kind);
}
function withBlock(doc: AnswerDoc, kind: Block['kind'], content: unknown): AnswerDoc {
  const existing = blockOf(doc, kind);
  if (existing) return { blocks: doc.blocks.map((b) => (b.id === existing.id ? { ...b, content } : b)) };
  // the structured part comes first, the written working after it
  return { blocks: [{ id: `${kind}-${uuid()}`, kind, content }, ...doc.blocks] };
}

/**
 * The part of an answer that is not free writing: the option(s) chosen (MCQ, MCQ_MULTI), the final answer (NUMERIC,
 * MATH) or the program (CODE). It lives in the same answer document and syncs like any paragraph.
 */
export function StructuredAnswer({ question, doc, onChange, disabled, attemptId }: { question: StructuredQuestion; doc: AnswerDoc; onChange: (d: AnswerDoc) => void; disabled: boolean; attemptId: string }) {
  const kind = question.kind;
  if (kind === 'MCQ' || kind === 'MCQ_MULTI') return <Choices question={question} doc={doc} onChange={onChange} disabled={disabled} multi={kind === 'MCQ_MULTI'} />;
  if (kind === 'NUMERIC' || kind === 'MATH') return <FinalAnswer doc={doc} onChange={onChange} disabled={disabled} math={kind === 'MATH'} />;
  if (kind === 'CODE' && question.codeSpec) return <CodeAnswer question={question as StructuredQuestion & { codeSpec: CodeSpec }} doc={doc} onChange={onChange} disabled={disabled} attemptId={attemptId} />;
  return null;
}

function Choices({ question, doc, onChange, disabled, multi }: { question: StructuredQuestion; doc: AnswerDoc; onChange: (d: AnswerDoc) => void; disabled: boolean; multi: boolean }) {
  const options = (Array.isArray(question.options) ? question.options : []) as Array<{ key: string; text: string }>;
  const raw = (blockOf(doc, 'choice')?.content as { selected?: string | string[] | null } | undefined)?.selected ?? null;
  const selected = new Set(raw === null ? [] : Array.isArray(raw) ? raw : [raw]);
  const pick = (key: string) => {
    if (disabled) return;
    if (multi) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onChange(withBlock(doc, 'choice', { selected: [...next].sort() }));
    } else onChange(withBlock(doc, 'choice', { selected: selected.has(key) ? null : key }));
  };
  return (
    <fieldset className="mb-6">
      <legend className="text-sm text-ink-2 mb-2">{multi ? 'Choose every correct option. A wrong choice costs part of this question, never below zero.' : 'Choose one option. Choose it again to clear it.'}</legend>
      <div className="flex flex-col gap-2" role={multi ? 'group' : 'radiogroup'}>
        {options.map((o) => {
          const on = selected.has(o.key);
          return (
            <label key={o.key} className={cn('flex items-start gap-3 p-3 rounded-md border cursor-pointer', on ? 'border-accent bg-accent-soft' : 'border-rule-2 bg-sheet', disabled && 'cursor-default opacity-80')}>
              <input type={multi ? 'checkbox' : 'radio'} name={`choice-${question.id}`} checked={on} onChange={() => pick(o.key)} onClick={(e) => { if (!multi && on) { e.preventDefault(); pick(o.key); } }} disabled={disabled} className="mt-1" />
              <span className="font-semibold text-ink-2 w-5">{o.key}.</span>
              <span>{o.text}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function FinalAnswer({ doc, onChange, disabled, math }: { doc: AnswerDoc; onChange: (d: AnswerDoc) => void; disabled: boolean; math: boolean }) {
  const text = (blockOf(doc, 'final')?.content as { text?: string } | undefined)?.text ?? '';
  return (
    <div className="mb-6 sheet p-4 border border-rule-2 rounded-md">
      <label className="block text-sm font-medium mb-1" htmlFor="final-answer">
        Final answer
      </label>
      <input id="final-answer" value={text} disabled={disabled} maxLength={500} onChange={(e) => onChange(withBlock(doc, 'final', { text: e.target.value }))} className="w-full h-11 rounded-md border border-rule-2 bg-sheet px-3 font-mono text-[16px]" aria-describedby="final-hint" autoComplete="off" spellCheck={false} />
      <p id="final-hint" className="text-xs text-ink-2 mt-1">
        {math ? 'Type the expression, e.g. 2(x+1)^2 or sqrt(3)/2. Any equivalent form is accepted.' : 'Type the number with its unit if the question asks for one, e.g. 9.33 ms or 500 mg.'} Show your working below: method marks are given for it.
      </p>
    </div>
  );
}

type RunResult = { runId: string; remaining: number; error: string | null; results: Array<{ test: number; passed: boolean; verdict: string; output: string; expected: string }> };

function CodeAnswer({ question, doc, onChange, disabled, attemptId }: { question: StructuredQuestion & { codeSpec: CodeSpec }; doc: AnswerDoc; onChange: (d: AnswerDoc) => void; disabled: boolean; attemptId: string }) {
  const spec = question.codeSpec;
  const current = blockOf(doc, 'code')?.content as { language?: CodeLanguageId; source?: string } | undefined;
  // start in the language the examiner gave starter code for, else the first allowed one
  const language = current?.language ?? spec.languages.find((l) => spec.starter?.[l]) ?? spec.languages[0]!;
  const source = current?.source ?? spec.starter?.[language] ?? '';
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: { language?: CodeLanguageId; source?: string }) => onChange(withBlock(doc, 'code', { language, source, ...patch }));
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // place the caret in the same commit as the new text, so the next keystroke lands after the indent
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && editorRef.current) {
      editorRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab indents (four spaces) instead of leaving the editor
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = el.selectionStart;
    pendingCaret.current = at + 4;
    set({ source: `${source.slice(0, at)}    ${source.slice(el.selectionEnd)}` });
  };
  const runSamples = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setRun(await api.post<RunResult>(`/student/attempts/${attemptId}/code-runs`, { questionId: question.id, language, source }, { quiet: ['SAMPLE_RUNS_EXHAUSTED', 'JUDGE_UNAVAILABLE', 'LANGUAGE_NOT_ALLOWED'] }));
    } catch (e) {
      setProblem(isApiError(e) ? e.problem.title : 'The sample run did not complete. Your program is saved and will still be graded.');
    } finally {
      setBusy(false);
    }
  };
  const allowed = spec.sampleRunsAllowed ?? 10;
  return (
    <section className="mb-6 flex flex-col gap-3" aria-label="Program answer">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium" htmlFor="code-language">
          Language
        </label>
        <select id="code-language" value={language} disabled={disabled} onChange={(e) => set({ language: e.target.value as CodeLanguageId, source: source || spec.starter?.[e.target.value as CodeLanguageId] || '' })} className="h-10 rounded-md border border-rule-2 bg-sheet px-2">
          {spec.languages.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_LABEL[l]}
            </option>
          ))}
        </select>
        <span className="text-xs text-ink-2">
          Limits: {(spec.timeLimitMs ?? 2000) / 1000} s, {spec.memoryMb ?? 128} MB. Graded after the exam on hidden tests.
        </span>
      </div>
      <label className="sr-only" htmlFor="code-source">
        Program
      </label>
      <textarea ref={editorRef} id="code-source" value={source} disabled={disabled} onChange={(e) => set({ source: e.target.value })} onKeyDown={onKeyDown} spellCheck={false} autoCorrect="off" autoCapitalize="off" rows={18} className="w-full rounded-md border border-rule-2 bg-sheet p-3 font-mono text-[14px] leading-relaxed" />
      {spec.samples?.length ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void runSamples()} loading={busy} disabled={disabled || !source.trim() || (run ? run.remaining <= 0 : false)}>
            Run sample tests
          </Button>
          <span className="text-sm text-ink-2" role="status">
            {run ? `${run.remaining} of ${allowed} runs left` : `${allowed} runs allowed`}
          </span>
        </div>
      ) : null}
      {problem ? (
        <p className="text-sm text-fix" role="alert">
          {problem}
        </p>
      ) : null}
      {run ? (
        <ol className="text-sm border border-rule rounded-md divide-y divide-rule" aria-label="Sample test results">
          {run.error ? <li className="p-2 text-fix">The run could not complete: {run.error}</li> : null}
          {run.results.map((r) => (
            <li key={r.test} className="p-2 grid gap-1">
              <span className={r.passed ? 'text-ready font-medium' : 'text-stop font-medium'}>
                Sample {r.test}: {r.passed ? 'passed' : r.verdict}
              </span>
              {!r.passed ? (
                <span className="font-mono text-xs text-ink-2 whitespace-pre-wrap">
                  expected {JSON.stringify(r.expected)} · got {JSON.stringify(r.output)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** Read-only view of the structured part, for the booklet and the marking screen. */
export function StructuredRender({ block }: { block: Block }) {
  const c = block.content as Record<string, unknown> | null;
  if (!c) return null;
  if (block.kind === 'choice') {
    const sel = c['selected'];
    const list = sel === null || sel === undefined ? [] : Array.isArray(sel) ? sel : [sel];
    return <p className="font-medium">Chosen: {list.length ? list.join(', ') : 'none'}</p>;
  }
  if (block.kind === 'final') return <p className="font-medium">Final answer: <span className="font-mono">{String(c['text'] ?? '')}</span></p>;
  if (block.kind === 'code') {
    return (
      <figure className="border border-rule-2 rounded-sm bg-sheet p-2">
        <figcaption className="text-xs text-ink-2 mb-1">Program ({LANGUAGE_LABEL[c['language'] as CodeLanguageId] ?? String(c['language'])})</figcaption>
        <pre className="font-mono text-[13px] whitespace-pre overflow-x-auto">{String(c['source'] ?? '')}</pre>
      </figure>
    );
  }
  return null;
}
