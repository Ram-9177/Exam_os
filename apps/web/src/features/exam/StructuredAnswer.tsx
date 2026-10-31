import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, isApiError } from '@/lib/api';
import type { AnswerDoc, Block, CodeLanguageId } from '@/lib/answers';
import { uuid } from '@/lib/ids';
import { codeLanguage } from '@examos/contracts';
import { Button, cn } from '@/ui';

export interface CodeSpec {
  languages: CodeLanguageId[];
  starter?: Partial<Record<CodeLanguageId, string>>;
  samples?: Array<{ input: string; expected: string }>;
  timeLimitMs?: number;
  memoryMb?: number;
  sampleRunsAllowed?: number;
  /** build-level question: the files (some read-only) and the setter's build/run commands */
  project?: { files: Array<{ path: string; content: string; editable: boolean }>; build: string | null; run: string };
}
export interface StructuredQuestion {
  id: string;
  kind?: string;
  options?: unknown;
  codeSpec?: CodeSpec;
}

const languageLabel = (id: string) => {
  const l = codeLanguage(id);
  return l ? `${l.label} (${l.version})` : id;
};

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

type RunResult = { runId: string; remaining: number; error: string | null; results: Array<{ test: number; passed: boolean; verdict: string; output: string; expected: string; compileOutput?: string }> };
type CodeContent = { language?: CodeLanguageId; source?: string; files?: Record<string, string> };

function CodeAnswer({ question, doc, onChange, disabled, attemptId }: { question: StructuredQuestion & { codeSpec: CodeSpec }; doc: AnswerDoc; onChange: (d: AnswerDoc) => void; disabled: boolean; attemptId: string }) {
  const spec = question.codeSpec;
  const project = spec.project;
  const current = blockOf(doc, 'code')?.content as CodeContent | undefined;
  // start in the language the examiner gave starter code for, else the first allowed one (a project has one toolchain)
  const language = project ? spec.languages[0]! : (current?.language ?? spec.languages.find((l) => spec.starter?.[l]) ?? spec.languages[0]!);
  const source = project ? '' : (current?.source ?? spec.starter?.[language] ?? '');
  // a project answer holds only the editable files; each starts from the setter's version
  const files: Record<string, string> = project ? Object.fromEntries(project.files.filter((f) => f.editable).map((f) => [f.path, current?.files?.[f.path] ?? f.content])) : {};
  const [activePath, setActivePath] = useState<string>(() => project?.files.find((f) => f.editable)?.path ?? project?.files[0]?.path ?? '');
  const active = project?.files.find((f) => f.path === activePath) ?? project?.files[0];
  const activeEditable = !project || !!active?.editable;
  const text = project ? (active?.editable ? (files[active.path] ?? '') : (active?.content ?? '')) : source;

  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: CodeContent) => onChange(withBlock(doc, 'code', project ? { language, source: '', files, ...patch } : { language, source, ...patch }));
  const setText = (value: string) => (project ? set({ files: { ...files, [active!.path]: value } }) : set({ source: value }));
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
    if (e.key !== 'Tab' || e.shiftKey || !activeEditable) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = el.selectionStart;
    pendingCaret.current = at + 4;
    setText(`${text.slice(0, at)}    ${text.slice(el.selectionEnd)}`);
  };
  const hasCode = project ? Object.values(files).some((f) => f.trim()) : !!source.trim();
  const runSamples = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setRun(await api.post<RunResult>(`/student/attempts/${attemptId}/code-runs`, project ? { questionId: question.id, language, source: '', files } : { questionId: question.id, language, source }, { quiet: ['SAMPLE_RUNS_EXHAUSTED', 'JUDGE_UNAVAILABLE', 'LANGUAGE_NOT_ALLOWED', 'NOTHING_TO_RUN'] }));
    } catch (e) {
      setProblem(isApiError(e) ? (e.problem.detail ?? e.problem.title) : 'The sample run did not complete. Your program is saved and will still be graded.');
    } finally {
      setBusy(false);
    }
  };
  const allowed = spec.sampleRunsAllowed ?? 10;
  return (
    <section className="mb-6 flex flex-col gap-3" aria-label="Program answer">
      <div className="flex flex-wrap items-center gap-3">
        {project ? (
          <span className="text-sm">
            <span className="font-medium">Language:</span> {languageLabel(language)}
          </span>
        ) : (
          <>
            <label className="text-sm font-medium" htmlFor="code-language">
              Language
            </label>
            <select id="code-language" value={language} disabled={disabled} onChange={(e) => set({ language: e.target.value as CodeLanguageId, source: source || spec.starter?.[e.target.value as CodeLanguageId] || '' })} className="h-10 rounded-md border border-rule-2 bg-sheet px-2">
              {spec.languages.map((l) => (
                <option key={l} value={l}>
                  {languageLabel(l)}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="text-xs text-ink-2">
          Limits: {(spec.timeLimitMs ?? 2000) / 1000} s, {spec.memoryMb ?? 128} MB. Graded after the exam on hidden tests.
        </span>
      </div>
      {project ? (
        <>
          <p className="text-xs text-ink-2">
            This is a project: change the files marked <em>yours</em>. It is built with <code className="font-mono">{project.build ?? '(no build step)'}</code> and run with <code className="font-mono">{project.run}</code>.
          </p>
          <div role="tablist" aria-label="Project files" className="flex flex-wrap gap-1 border-b border-rule">
            {project.files.map((f) => (
              <button key={f.path} type="button" role="tab" aria-selected={f.path === active?.path} onClick={() => setActivePath(f.path)} className={cn('px-3 py-1.5 text-sm font-mono rounded-t-md border border-b-0', f.path === active?.path ? 'border-rule-2 bg-sheet font-semibold' : 'border-transparent text-ink-2')}>
                {f.path} <span className="font-sans text-xs">{f.editable ? '· yours' : '· read-only'}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      <label className="sr-only" htmlFor="code-source">
        {project ? `File ${active?.path ?? ''}` : 'Program'}
      </label>
      <textarea ref={editorRef} id="code-source" value={text} disabled={disabled} readOnly={!activeEditable} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} autoCorrect="off" autoCapitalize="off" rows={18} className={cn('w-full rounded-md border border-rule-2 p-3 font-mono text-[14px] leading-relaxed', activeEditable ? 'bg-sheet' : 'bg-sheet-2 text-ink-2')} />
      {spec.samples?.length ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void runSamples()} loading={busy} disabled={disabled || !hasCode || (run ? run.remaining <= 0 : false)}>
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
              {!r.passed && !r.compileOutput ? (
                <span className="font-mono text-xs text-ink-2 whitespace-pre-wrap">
                  expected {JSON.stringify(r.expected)} · got {JSON.stringify(r.output)}
                </span>
              ) : null}
              {r.compileOutput ? <pre className="font-mono text-xs text-ink-2 whitespace-pre-wrap">{r.compileOutput}</pre> : null}
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
    const files = c['files'] && typeof c['files'] === 'object' ? Object.entries(c['files'] as Record<string, string>) : [];
    if (files.length) {
      return (
        <div className="grid gap-2">
          {files.map(([path, body]) => (
            <figure key={path} className="border border-rule-2 rounded-sm bg-sheet p-2">
              <figcaption className="text-xs text-ink-2 mb-1">
                <span className="font-mono">{path}</span> ({languageLabel(String(c['language']))})
              </figcaption>
              <pre className="font-mono text-[13px] whitespace-pre overflow-x-auto">{String(body ?? '')}</pre>
            </figure>
          ))}
        </div>
      );
    }
    return (
      <figure className="border border-rule-2 rounded-sm bg-sheet p-2">
        <figcaption className="text-xs text-ink-2 mb-1">Program ({languageLabel(String(c['language']))})</figcaption>
        <pre className="font-mono text-[13px] whitespace-pre overflow-x-auto">{String(c['source'] ?? '')}</pre>
      </figure>
    );
  }
  return null;
}
