import type { Knex } from '@examos/db';
import { withTenantTx, withWorkerTx } from '@examos/db';
import type { CodeLanguage } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { sha256Hex } from '../../lib/crypto.js';
import { snapshotProposals } from './auto-marks.js';

/**
 * Running students' programs. Never in the API or worker process: every run goes to a self-hosted Judge0 — an
 * isolated sandbox (no network, CPU/memory/time limits, throwaway file system) on its own server. ExamOS only sends
 * source, input and limits, and compares the output. Without JUDGE_URL nothing is run and CODE answers are marked by
 * examiners alone.
 */
export const JUDGE0_LANGUAGE: Record<CodeLanguage, number> = { c: 50, cpp: 54, java: 62, python: 71 };

export interface JudgeTest {
  input: string;
  expected: string;
  weight?: number;
}
export interface JudgeResult {
  index: number;
  passed: boolean;
  verdict: string;
  stdout?: string;
  timeMs?: number;
}
export interface Judge {
  run(language: CodeLanguage, source: string, tests: JudgeTest[], limits: { timeLimitMs: number; memoryMb: number }): Promise<JudgeResult[]>;
}

/** Output comparison the way judges do it: trailing spaces and the final newline do not matter. */
export const sameOutput = (a: string, b: string) => a.replace(/[ \t]+$/gm, '').replace(/\s+$/, '') === b.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');

export function judge0(baseUrl: string, token?: string, fetchImpl: typeof fetch = fetch): Judge {
  return {
    async run(language, source, tests, limits) {
      const out: JudgeResult[] = [];
      for (const [index, t] of tests.entries()) {
        const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/submissions?base64_encoded=false&wait=true`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { 'X-Auth-Token': token } : {}) },
          body: JSON.stringify({ language_id: JUDGE0_LANGUAGE[language], source_code: source, stdin: t.input, cpu_time_limit: limits.timeLimitMs / 1000, wall_time_limit: (limits.timeLimitMs / 1000) * 3, memory_limit: limits.memoryMb * 1024, enable_network: false }),
          signal: AbortSignal.timeout(Math.max(10_000, limits.timeLimitMs * 5)),
        });
        if (!res.ok) throw new Error(`judge answered ${res.status}`);
        const body = (await res.json()) as { stdout?: string | null; status?: { id: number; description: string }; time?: string | null; compile_output?: string | null };
        const statusId = body.status?.id ?? 0;
        // 3 = finished normally; we still compare ourselves so the verdict never depends on the judge's comparison
        const finished = statusId === 3 || statusId === 4;
        const passed = finished && sameOutput(body.stdout ?? '', t.expected);
        const verdict = passed ? 'passed' : statusId === 4 || (finished && !passed) ? 'wrong answer' : statusId === 5 ? 'time limit exceeded' : statusId === 6 ? 'compilation error' : (body.status?.description ?? 'error').toLowerCase();
        out.push({ index, passed, verdict, stdout: (body.stdout ?? '').slice(0, 2000), timeMs: body.time ? Math.round(Number(body.time) * 1000) : undefined });
        if (statusId === 6) {
          // nothing else can pass when it does not compile
          for (let k = index + 1; k < tests.length; k++) out.push({ index: k, passed: false, verdict: 'compilation error' });
          break;
        }
      }
      return out;
    },
  };
}

export function judgeFor(deps: AppDeps): Judge | null {
  return deps.judge ?? (deps.config.JUDGE_URL ? judge0(deps.config.JUDGE_URL, deps.config.JUDGE_TOKEN) : null);
}

interface CodeQuestionRow {
  question_id: string;
  kind: string;
  expected_answer: unknown;
  code_spec: { languages?: string[]; timeLimitMs?: number; memoryMb?: number; samples?: Array<{ input: string; expected: string }>; sampleRunsAllowed?: number } | null;
}

export function hiddenTests(q: CodeQuestionRow): JudgeTest[] {
  const ea = (q.expected_answer ?? {}) as { tests?: unknown };
  return (Array.isArray(ea.tests) ? ea.tests : []).filter((t): t is JudgeTest => !!t && typeof (t as JudgeTest).input === 'string' && typeof (t as JudgeTest).expected === 'string');
}

/** Queue a grading run for every CODE answer of a sealed script that has no run for its current source yet. */
export async function enqueueCodeGrading(trx: Knex.Transaction, tenantId: string, examId: string, attemptId: string): Promise<number> {
  const paper = await trx('question_papers').where({ tenant_id: tenantId, exam_id: examId, status: 'APPROVED' }).first('id');
  if (!paper) return 0;
  const codeQs = await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id, kind: 'CODE' }).select('question_id');
  if (!codeQs.length) return 0;
  const docs = await trx('answer_documents').where({ tenant_id: tenantId, attempt_id: attemptId }).whereIn('question_id', codeQs.map((q) => q.question_id)).select('question_id', 'content');
  let queued = 0;
  for (const d of docs) {
    const content = typeof d.content === 'string' ? JSON.parse(d.content) : d.content;
    const code = ((content?.blocks ?? []) as Array<{ kind: string; content: { language?: string; source?: string } }>).find((b) => b.kind === 'code')?.content;
    if (!code?.source?.trim() || !code.language) continue;
    const hash = sha256Hex(`${code.language}\n${code.source}`);
    const existing = await trx('code_runs').where({ tenant_id: tenantId, attempt_id: attemptId, question_id: d.question_id, purpose: 'GRADING', source_sha256: hash }).whereIn('status', ['QUEUED', 'RUNNING', 'DONE']).first('id');
    if (existing) continue;
    await trx('code_runs').insert({ tenant_id: tenantId, attempt_id: attemptId, question_id: d.question_id, purpose: 'GRADING', language: code.language, source_sha256: hash });
    queued++;
  }
  return queued;
}

/**
 * Worker pass: claim queued grading runs (a lease, so a crashed worker's runs are picked up again after 5 minutes),
 * run them outside any transaction, store the results and refresh the script's proposals.
 */
export async function runCodeJudgeOnce(deps: AppDeps, batch = 5): Promise<number> {
  const claimed = await withWorkerTx(deps.db, async (trx) => {
    const rows = await trx('code_runs')
      .where((qb) => qb.where('status', 'QUEUED').orWhere((q2) => q2.where('status', 'RUNNING').where('claimed_at', '<', trx.raw("now() - interval '5 minutes'"))))
      .where('purpose', 'GRADING')
      .orderBy('created_at')
      .limit(batch)
      .forUpdate()
      .skipLocked()
      .select('id', 'tenant_id', 'attempt_id', 'question_id', 'language', 'attempts');
    if (rows.length) await trx('code_runs').whereIn('id', rows.map((r) => r.id)).update({ status: 'RUNNING', claimed_at: trx.fn.now(), attempts: trx.raw('attempts + 1') });
    return rows;
  });
  const judge = judgeFor(deps);
  for (const run of claimed) {
    let outcome: { status: 'DONE' | 'ERROR'; results?: JudgeResult[]; passed?: number; total?: number; error?: string };
    let examId = '';
    try {
      const ctx = await withTenantTx(deps.db, run.tenant_id, async (trx) => {
        const attempt = await trx('exam_attempts').where({ id: run.attempt_id }).first('exam_id');
        const paper = await trx('question_papers').where({ tenant_id: run.tenant_id, exam_id: attempt.exam_id, status: 'APPROVED' }).first('id');
        const q = (await trx('paper_questions').where({ paper_id: paper.id, question_id: run.question_id }).first('question_id', 'kind', 'expected_answer', 'code_spec')) as CodeQuestionRow;
        const doc = await trx('answer_documents').where({ attempt_id: run.attempt_id, question_id: run.question_id }).first('content');
        const content = typeof doc?.content === 'string' ? JSON.parse(doc.content) : doc?.content;
        const code = ((content?.blocks ?? []) as Array<{ kind: string; content: { language: CodeLanguage; source: string } }>).find((b) => b.kind === 'code')?.content;
        return { examId: attempt.exam_id as string, q, code };
      });
      examId = ctx.examId;
      const tests = hiddenTests(ctx.q);
      if (!judge) outcome = { status: 'ERROR', error: 'no judge configured (JUDGE_URL)' };
      else if (!ctx.code || !tests.length) outcome = { status: 'ERROR', error: !tests.length ? 'the question has no hidden tests' : 'no program in the answer' };
      else {
        const results = await judge.run(ctx.code.language, ctx.code.source, tests, { timeLimitMs: ctx.q.code_spec?.timeLimitMs ?? 2000, memoryMb: ctx.q.code_spec?.memoryMb ?? 128 });
        const total = tests.reduce((a, t) => a + (t.weight ?? 1), 0);
        const passed = results.reduce((a, r) => a + (r.passed ? (tests[r.index]!.weight ?? 1) : 0), 0);
        outcome = { status: 'DONE', results, passed, total };
      }
    } catch (e) {
      // a judge outage is retried (lease) up to 3 times, then left to the examiner
      if (run.attempts + 1 < 3) {
        await withTenantTx(deps.db, run.tenant_id, (trx) => trx('code_runs').where('id', run.id).update({ status: 'QUEUED', claimed_at: null, error: String(e instanceof Error ? e.message : e).slice(0, 500) }));
        continue;
      }
      outcome = { status: 'ERROR', error: String(e instanceof Error ? e.message : e).slice(0, 500) };
    }
    await withTenantTx(deps.db, run.tenant_id, async (trx) => {
      await trx('code_runs').where('id', run.id).update({ status: outcome.status, results: outcome.results ? JSON.stringify(outcome.results) : null, passed_weight: outcome.passed ?? null, total_weight: outcome.total ?? null, error: outcome.error ?? null, finished_at: trx.fn.now() });
      if (examId) await snapshotProposals(trx, run.tenant_id, examId, run.attempt_id);
    });
  }
  return claimed.length;
}

/**
 * A student's sample run during the exam: only the question's visible sample tests, only on the student's own live
 * attempt, and at most `sampleRunsAllowed` times per question (the run is reserved in a transaction before the judge
 * is called, so parallel clicks cannot exceed the limit). Hidden tests never run here.
 */
export async function runSampleTests(deps: AppDeps, tenantId: string, userId: string, attemptId: string, deviceSession: string | null, input: { questionId: string; language: CodeLanguage; source: string }) {
  const { AppError } = await import('../../lib/errors.js');
  const { assertDeviceSession } = await import('../attempts/service.js');
  const judge = judgeFor(deps);
  const reserved = await withTenantTx(deps.db, tenantId, async (trx) => {
    const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).forNoKeyUpdate().first();
    if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
    if (attempt.status !== 'ACTIVE') throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}`);
    await assertDeviceSession(deps, trx, tenantId, attempt, deviceSession);
    const paper = await trx('question_papers').where({ tenant_id: tenantId, exam_id: attempt.exam_id, status: 'APPROVED' }).first('id');
    const q = paper ? ((await trx('paper_questions').where({ paper_id: paper.id, question_id: input.questionId }).first('question_id', 'kind', 'expected_answer', 'code_spec')) as CodeQuestionRow | undefined) : undefined;
    if (!q || q.kind !== 'CODE') throw AppError.notFound('QUESTION_NOT_FOUND', 'Not a coding question of this exam');
    const spec = q.code_spec ?? {};
    if (spec.languages && !spec.languages.includes(input.language)) throw AppError.unprocessable('LANGUAGE_NOT_ALLOWED', `This question accepts ${spec.languages.join(', ')}`);
    if (!judge) throw new AppError(503, 'JUDGE_UNAVAILABLE', 'Running code is not available for this exam; write your program and submit it as usual.');
    const used = await trx('code_runs').where({ tenant_id: tenantId, attempt_id: attemptId, question_id: input.questionId, purpose: 'SAMPLE' }).count<{ count: string }[]>('id as count');
    const allowed = spec.sampleRunsAllowed ?? 10;
    if (Number(used[0]?.count ?? 0) >= allowed) throw new AppError(429, 'SAMPLE_RUNS_EXHAUSTED', `All ${allowed} sample runs for this question are used; your program is still graded on the hidden tests after the exam.`);
    const [row] = await trx('code_runs').insert({ tenant_id: tenantId, attempt_id: attemptId, question_id: input.questionId, purpose: 'SAMPLE', language: input.language, source_sha256: sha256Hex(`${input.language}\n${input.source}`), status: 'RUNNING', claimed_at: trx.fn.now(), attempts: 1 }).returning('id');
    return { runId: row.id as string, samples: spec.samples ?? [], limits: { timeLimitMs: spec.timeLimitMs ?? 2000, memoryMb: spec.memoryMb ?? 128 }, remaining: allowed - Number(used[0]?.count ?? 0) - 1 };
  });
  let results: JudgeResult[] = [];
  let error: string | null = null;
  try {
    results = reserved.samples.length ? await judge!.run(input.language, input.source, reserved.samples, reserved.limits) : [];
  } catch (e) {
    error = String(e instanceof Error ? e.message : e).slice(0, 500);
  }
  await withTenantTx(deps.db, tenantId, (trx) => trx('code_runs').where('id', reserved.runId).update({ status: error ? 'ERROR' : 'DONE', results: JSON.stringify(results), passed_weight: results.filter((r) => r.passed).length, total_weight: reserved.samples.length, error, finished_at: trx.fn.now() }));
  return { runId: reserved.runId, remaining: reserved.remaining, error, results: results.map((r) => ({ test: r.index + 1, passed: r.passed, verdict: r.verdict, output: r.stdout ?? '', expected: reserved.samples[r.index]?.expected ?? '' })) };
}
