import { useEffect, useState } from 'react';
import { CODE_LANGUAGE_CATALOGUE } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { Button, Field, Select, TextArea, TextInput } from '@/ui';
import { useExamCodeLanguages, type CodeCheck, type CodeProjectInput, type CodeSpecInput, type LanguageOption, type PaperQuestion } from './api';

type Test = { input: string; expected: string; weight?: number };
type Reference = { language: string; source: string; files?: Record<string, string> };

/**
 * Typical build and run commands per toolchain, as a starting point only: the sandbox has no network, so they must use
 * what the judge image has installed. "Check with reference" proves they work before the paper can be approved.
 */
const PRESETS: Record<string, { files: CodeProjectInput['files']; build: string | null; run: string }> = {
  java: { files: [{ path: 'Main.java', content: 'public class Main {\n    public static void main(String[] args) {\n        java.util.Scanner in = new java.util.Scanner(System.in);\n        System.out.println(Solution.solve(in.nextInt()));\n    }\n}\n' }, { path: 'Solution.java', content: 'class Solution {\n    static int solve(int n) {\n        return 0;\n    }\n}\n', editable: true }], build: 'javac -d out $(find . -name "*.java")', run: 'java -cp out Main' },
  c: { files: [{ path: 'main.c', content: '#include <stdio.h>\n#include "solution.h"\n\nint main(void) {\n    int n;\n    if (scanf("%d", &n) == 1) printf("%d\\n", solve(n));\n    return 0;\n}\n' }, { path: 'solution.h', content: 'int solve(int n);\n' }, { path: 'solution.c', content: '#include "solution.h"\n\nint solve(int n) {\n    return 0;\n}\n', editable: true }], build: 'gcc -O2 -Wall -o main *.c -lm', run: './main' },
  cpp: { files: [{ path: 'main.cpp', content: '#include <iostream>\n#include "solution.hpp"\n\nint main() {\n    int n;\n    std::cin >> n;\n    std::cout << solve(n) << "\\n";\n}\n' }, { path: 'solution.hpp', content: 'int solve(int n);\n' }, { path: 'solution.cpp', content: '#include "solution.hpp"\n\nint solve(int n) {\n    return 0;\n}\n', editable: true }], build: 'g++ -O2 -std=c++17 -o main *.cpp', run: './main' },
  python: { files: [{ path: 'main.py', content: 'from solution import solve\n\nprint(solve(int(input())))\n' }, { path: 'solution.py', content: 'def solve(n):\n    return 0\n', editable: true }], build: null, run: 'python3 main.py' },
};

const FALLBACK: LanguageOption[] = CODE_LANGUAGE_CATALOGUE.map(({ id, label, version, group }) => ({ id, label, version, group }));

function grouped(list: LanguageOption[]) {
  const out = new Map<string, LanguageOption[]>();
  for (const l of list) out.set(l.group, [...(out.get(l.group) ?? []), l]);
  return [...out.entries()];
}

/**
 * Everything a coding question needs: the languages (only the subject's), a single program or a multi-file project
 * with build and run commands, limits, visible samples, hidden tests, the setter's own reference solution, and the
 * check that runs the reference against the tests (required before approval while a sandbox is configured).
 */
export function CodeQuestionEditor({ examId, question, disabled, onChange }: { examId?: string; question: PaperQuestion; disabled: boolean; onChange: (patch: Partial<PaperQuestion>) => void }) {
  const langs = useExamCodeLanguages(examId);
  const allowed = langs.data?.languages ?? FALLBACK;
  const spec: CodeSpecInput = question.codeSpec ?? { languages: [langs.data?.default ?? (allowed.some((l) => l.id === 'python') ? 'python' : (allowed[0]?.id ?? 'python'))], samples: [], sampleRunsAllowed: 10, timeLimitMs: 2000, memoryMb: 128 };
  const setSpec = (patch: Partial<CodeSpecInput>) => onChange({ codeSpec: { ...spec, ...patch } });
  // a new coding question starts in the subject's default language, so what is shown is what is saved
  const missing = !question.codeSpec;
  const ready = !examId || langs.isFetched;
  useEffect(() => {
    if (missing && ready && !disabled) onChange({ codeSpec: spec });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, ready, disabled]);
  const ea = (question.expectedAnswer && typeof question.expectedAnswer === 'object' && !Array.isArray(question.expectedAnswer) ? question.expectedAnswer : {}) as { tests?: Test[]; reference?: Reference };
  const setKey = (patch: Partial<typeof ea>) => onChange({ expectedAnswer: { ...ea, ...patch } });
  const tests = Array.isArray(ea.tests) ? ea.tests : [];
  const project = spec.project;
  const toolchain = spec.languages[0] ?? 'python';
  const reference: Reference = ea.reference ?? { language: toolchain, source: '' };
  const label = (id: string) => allowed.find((l) => l.id === id)?.label ?? FALLBACK.find((l) => l.id === id)?.label ?? id;
  const outside = spec.languages.filter((l) => !allowed.some((a) => a.id === l));

  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CodeCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const shownCheck = check ?? question.codeCheck ?? null;
  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const r = await api.post<CodeCheck & { ok: boolean }>(`/exams/${examId}/paper/questions/${question.questionId}/check-code`, {}, { quiet: ['REFERENCE_REQUIRED', 'JUDGE_UNAVAILABLE', 'NO_TESTS', 'QUESTION_NOT_FOUND', 'LANGUAGE_NOT_ALLOWED', 'QUESTION_CHANGED', 'PAPER_APPROVED'] });
      // shown here; the saved paper picks it up on its next load (refetching now would drop unsaved edits)
      setCheck({ ...r, current: true });
    } catch (e) {
      setCheckError(isApiError(e) ? (e.problem.detail ?? e.problem.title) : 'The check did not complete.');
    } finally {
      setChecking(false);
    }
  };

  const toProject = () => {
    const preset = PRESETS[toolchain] ?? { files: [{ path: `main.${toolchain}`, content: '', editable: true }], build: null, run: '' };
    setSpec({ languages: [toolchain], project: { files: preset.files.map((f) => ({ ...f, editable: !!f.editable })), build: preset.build, run: preset.run } });
    setKey({ reference: { language: toolchain, source: '', files: Object.fromEntries(preset.files.filter((f) => f.editable).map((f) => [f.path, f.content])) } });
  };
  const toSingle = () => {
    setSpec({ project: undefined });
    setKey({ reference: { language: toolchain, source: '' } });
  };
  const setProject = (patch: Partial<CodeProjectInput>) => project && setSpec({ project: { ...project, ...patch } });
  const setFile = (i: number, patch: Partial<CodeProjectInput['files'][number]>) => project && setProject({ files: project.files.map((f, k) => (k === i ? { ...f, ...patch } : f)) });

  const pairs = (list: Test[], setList: (l: Test[]) => void, name: string, weights: boolean) => (
    <div className="space-y-2">
      {list.map((t, i) => (
        <div key={i} className={weights ? 'grid gap-2 sm:grid-cols-[1fr_1fr_5rem_auto]' : 'grid gap-2 sm:grid-cols-[1fr_1fr_auto]'}>
          <TextArea aria-label={`${name} ${i + 1} input`} rows={2} className="font-mono text-xs" value={t.input} disabled={disabled} onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, input: e.target.value } : x)))} />
          <TextArea aria-label={`${name} ${i + 1} expected output`} rows={2} className="font-mono text-xs" value={t.expected} disabled={disabled} onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, expected: e.target.value } : x)))} />
          {weights ? <TextInput aria-label={`${name} ${i + 1} weight`} type="number" min={1} placeholder="1" value={t.weight ?? ''} disabled={disabled} onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, weight: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1) } : x)))} /> : null}
          {!disabled ? <Button size="sm" variant="ghost" onClick={() => setList(list.filter((_, k) => k !== i))}>Remove</Button> : null}
        </div>
      ))}
      {!disabled ? <Button size="sm" onClick={() => setList([...list, { input: '', expected: '' }])}>Add {name.toLowerCase()}</Button> : null}
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2" role="note">
        {langs.data?.subject
          ? langs.data.subject.restricted
            ? `${langs.data.subject.code} ${langs.data.subject.name} uses ${allowed.map((l) => l.label).join(', ')}. Only these can be offered.`
            : `${langs.data.subject.code} has no language list yet, so any language can be offered. The Examination Section sets one under Coding languages.`
          : 'Any supported language can be offered.'}
      </p>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Kind of program</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name={`mode-${question.questionId}`} checked={!project} disabled={disabled} onChange={toSingle} /> One file: students write the whole program
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name={`mode-${question.questionId}`} checked={!!project} disabled={disabled} onChange={toProject} /> Project: several files, built and run by your commands (students edit only the files you mark)
        </label>
      </fieldset>

      {project ? (
        <Field label="Toolchain" hint="A project is built with one language's tools." className="w-72">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} value={toolchain} disabled={disabled} onChange={(e) => { setSpec({ languages: [e.target.value] }); setKey({ reference: { ...reference, language: e.target.value } }); }}>
              {allowed.map((l) => <option key={l.id} value={l.id}>{l.label} ({l.version})</option>)}
            </Select>
          )}
        </Field>
      ) : (
        <fieldset>
          <legend className="text-sm font-semibold mb-1">Languages students may choose</legend>
          {grouped(allowed).map(([group, list]) => (
            <div key={group} className="mb-2">
              <p className="text-xs text-ink-2">{group}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {list.map((l) => (
                  <label key={l.id} className="flex items-center gap-1 text-sm" title={l.version}>
                    <input type="checkbox" checked={spec.languages.includes(l.id)} disabled={disabled || (spec.languages.length === 1 && spec.languages[0] === l.id)} onChange={(e) => setSpec({ languages: e.target.checked ? [...spec.languages, l.id] : spec.languages.filter((x) => x !== l.id) })} />
                    {l.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      )}
      {outside.length ? <p className="text-sm text-fix" role="alert">{outside.map(label).join(', ')} is not a language of this subject; saving will be refused until it is removed.</p> : null}

      {project ? (
        <section className="space-y-3" aria-label="Project files">
          <h5 className="text-sm font-semibold">Files</h5>
          {project.files.map((f, i) => (
            <div key={i} className="border border-rule rounded-sm p-2 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <TextInput aria-label={`File ${i + 1} path`} className="font-mono w-64" value={f.path} disabled={disabled} onChange={(e) => setFile(i, { path: e.target.value })} />
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={!!f.editable} disabled={disabled} onChange={(e) => setFile(i, { editable: e.target.checked })} /> Students edit this file
                </label>
                {!disabled && project.files.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setProject({ files: project.files.filter((_, k) => k !== i) })}>Remove file</Button> : null}
              </div>
              <TextArea aria-label={`File ${i + 1} content`} rows={6} className="font-mono text-xs" value={f.content} disabled={disabled} onChange={(e) => setFile(i, { content: e.target.value })} spellCheck={false} />
            </div>
          ))}
          {!disabled ? <Button size="sm" onClick={() => setProject({ files: [...project.files, { path: '', content: '', editable: true }] })}>Add file</Button> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Build command" hint="Leave empty for interpreted languages. No network in the sandbox.">{({ id, describedBy }) => <TextInput id={id} aria-describedby={describedBy} className="font-mono" value={project.build ?? ''} disabled={disabled} onChange={(e) => setProject({ build: e.target.value.trim() ? e.target.value : null })} />}</Field>
            <Field label="Run command" hint="Reads the test input on stdin, prints the answer.">{({ id, describedBy }) => <TextInput id={id} aria-describedby={describedBy} className="font-mono" value={project.run} disabled={disabled} onChange={(e) => setProject({ run: e.target.value })} />}</Field>
          </div>
        </section>
      ) : (
        <Field label={`Starter code (${label(spec.languages[0] ?? toolchain)})`} hint="Optional: what students see when they open the question.">
          {({ id, describedBy }) => <TextArea id={id} aria-describedby={describedBy} rows={4} className="font-mono text-xs" value={spec.starter?.[spec.languages[0] ?? toolchain] ?? ''} disabled={disabled} spellCheck={false} onChange={(e) => setSpec({ starter: { ...(spec.starter ?? {}), [spec.languages[0] ?? toolchain]: e.target.value } })} />}
        </Field>
      )}

      <div className="flex flex-wrap gap-3">
        <Field label="Time limit (ms)" className="w-32">{({ id }) => <TextInput id={id} type="number" min={100} max={10000} value={spec.timeLimitMs ?? 2000} disabled={disabled} onChange={(e) => setSpec({ timeLimitMs: Number(e.target.value) })} />}</Field>
        <Field label="Memory (MB)" className="w-28">{({ id }) => <TextInput id={id} type="number" min={16} max={512} value={spec.memoryMb ?? 128} disabled={disabled} onChange={(e) => setSpec({ memoryMb: Number(e.target.value) })} />}</Field>
        <Field label="Sample runs per student" className="w-44">{({ id }) => <TextInput id={id} type="number" min={0} max={50} value={spec.sampleRunsAllowed ?? 10} disabled={disabled} onChange={(e) => setSpec({ sampleRunsAllowed: Number(e.target.value) })} />}</Field>
      </div>
      <div>
        <p className="text-sm font-semibold">Sample tests (students see these and may run them)</p>
        {pairs(spec.samples ?? [], (l) => setSpec({ samples: l.map(({ input, expected }) => ({ input, expected })) }), 'Sample', false)}
      </div>
      <div>
        <p className="text-sm font-semibold">Hidden tests (grade the program after the exam; never shown to students)</p>
        {pairs(tests, (l) => setKey({ tests: l }), 'Hidden test', true)}
      </div>

      <section className="space-y-2 border-t border-rule pt-3" aria-label="Reference solution">
        <h5 className="text-sm font-semibold">Your solution (reference)</h5>
        <p className="text-xs text-ink-2">Never shown to students. It is run against every sample and hidden test to prove the expected outputs are right. While a code sandbox is connected, the paper cannot be approved until it passes all of them.</p>
        {project ? (
          project.files.filter((f) => f.editable).map((f) => (
            <Field key={f.path} label={`Reference ${f.path}`}>
              {({ id }) => <TextArea id={id} rows={5} className="font-mono text-xs" value={reference.files?.[f.path] ?? ''} disabled={disabled} spellCheck={false} onChange={(e) => setKey({ reference: { language: toolchain, source: '', files: { ...(reference.files ?? {}), [f.path]: e.target.value } } })} />}
            </Field>
          ))
        ) : (
          <>
            <Field label="Reference language" className="w-56">
              {({ id }) => (
                <Select id={id} value={spec.languages.includes(reference.language) ? reference.language : (spec.languages[0] ?? '')} disabled={disabled} onChange={(e) => setKey({ reference: { ...reference, language: e.target.value } })}>
                  {spec.languages.map((l) => <option key={l} value={l}>{label(l)}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Reference program">{({ id }) => <TextArea id={id} rows={6} className="font-mono text-xs" value={reference.source} disabled={disabled} spellCheck={false} onChange={(e) => setKey({ reference: { language: spec.languages.includes(reference.language) ? reference.language : (spec.languages[0] ?? toolchain), source: e.target.value } })} />}</Field>
          </>
        )}
        {examId && !disabled ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void runCheck()} loading={checking}>Check with reference</Button>
            <span className="text-xs text-ink-2">Save the draft first: the saved question is what is checked.</span>
          </div>
        ) : null}
        {checkError ? <p className="text-sm text-fix" role="alert">{checkError}</p> : null}
        {shownCheck ? <CheckResult check={shownCheck} /> : null}
      </section>
    </div>
  );
}

function CheckResult({ check }: { check: CodeCheck }) {
  const ok = check.passed === check.total;
  return (
    <div className="space-y-2" aria-label="Reference check">
      <p className={ok && check.current !== false ? 'text-sm text-ready font-medium' : 'text-sm text-fix font-medium'} role="status">
        {check.current === false ? `Checked before the last change (${check.passed} of ${check.total} passed): check again.` : ok ? `The reference passes all ${check.total} tests.` : `The reference passes ${check.passed} of ${check.total} tests: fix the failing tests (or the reference) and check again.`}
      </p>
      <ol className="text-xs border border-rule rounded-md divide-y divide-rule">
        {check.results.map((r) => (
          <li key={r.test} className="p-2 grid gap-1">
            <span className={r.passed ? 'text-ready' : 'text-stop'}>
              {r.kind === 'sample' ? 'Sample' : 'Hidden'} test {r.test}: {r.passed ? 'passed' : r.verdict}
            </span>
            {!r.passed ? <span className="font-mono text-ink-2 whitespace-pre-wrap">input {JSON.stringify(r.input)} · expected {JSON.stringify(r.expected)} · got {JSON.stringify(r.output)}</span> : null}
            {r.compileOutput ? <pre className="font-mono text-ink-2 whitespace-pre-wrap">{r.compileOutput}</pre> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
