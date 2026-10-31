import { crc32 } from 'node:zlib';
import type { Knex } from '@examos/db';
import { withTenantTx, withWorkerTx } from '@examos/db';
import { CODE_LANGUAGE_CATALOGUE, JUDGE0_MULTI_FILE, codeLanguage, type CodeLanguage, type CodeProject } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { sha256Hex } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { snapshotProposals } from './auto-marks.js';

/**
 * Running programs. Never in the API or worker process: every run goes to a self-hosted Judge0 — an isolated sandbox
 * (no network, CPU/memory/time limits, throwaway file system) on its own server. ExamOS only sends the program, input
 * and limits, and compares the output itself. Without JUDGE_URL nothing is run and CODE answers are marked by
 * examiners alone.
 *
 * Two shapes of program:
 * - single: one source file in any catalogue language (Judge0 picks the compiler by language id);
 * - project: a multi-file build (Judge0 "Multi-file program"): the files go in a zip with the setter's `compile` and
 *   `run` scripts. Students change only the files the setter marked editable; the scripts are never theirs.
 */
export type Program =
  | { kind: 'single'; language: CodeLanguage; source: string }
  | { kind: 'project'; language: CodeLanguage; files: Record<string, string>; build: string | null; run: string };

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
  /** compiler/build output, first failure only (helps the setter and the examiner, never decides marks) */
  compileOutput?: string;
}
export interface Judge {
  run(program: Program, tests: JudgeTest[], limits: { timeLimitMs: number; memoryMb: number }): Promise<JudgeResult[]>;
  /** What the sandbox has installed (Judge0 GET /languages), for the language status page. */
  languages?(): Promise<Array<{ id: number; name: string }>>;
}

/** Output comparison the way judges do it: trailing spaces and the final newline do not matter. */
export const sameOutput = (a: string, b: string) => a.replace(/[ \t]+$/gm, '').replace(/\s+$/, '') === b.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');

/** Judge0 ids for this deployment: the catalogue's, with JUDGE_LANGUAGE_IDS overrides. */
export function judge0Ids(overrides?: string): Record<string, number> {
  const ids: Record<string, number> = Object.fromEntries(CODE_LANGUAGE_CATALOGUE.map((l) => [l.id, l.judge0]));
  if (overrides) Object.assign(ids, JSON.parse(overrides) as Record<string, number>);
  return ids;
}

/** A plain (stored, uncompressed) zip: enough for Judge0's additional_files, no dependency. */
export function zipStore(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01: fixed, so the same files give the same zip
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

export function judge0(baseUrl: string, token?: string, fetchImpl: typeof fetch = fetch, idOverrides?: string): Judge {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(token ? { 'X-Auth-Token': token } : {}) };
  const ids = judge0Ids(idOverrides);
  return {
    async run(program, tests, limits) {
      const what =
        program.kind === 'single'
          ? { language_id: ids[program.language], source_code: program.source }
          : { language_id: JUDGE0_MULTI_FILE, additional_files: zipStore({ ...program.files, ...(program.build ? { compile: `${program.build}\n` } : {}), run: `${program.run}\n` }).toString('base64') };
      if (!what.language_id) throw new Error(`no judge language for ${program.language}`);
      const out: JudgeResult[] = [];
      for (const [index, t] of tests.entries()) {
        const res = await fetchImpl(`${base}/submissions?base64_encoded=false&wait=true`, {
          method: 'POST',
          headers,
          // builds get more wall time than the program itself (compilers are slow, tests are not)
          body: JSON.stringify({ ...what, stdin: t.input, cpu_time_limit: limits.timeLimitMs / 1000, wall_time_limit: (limits.timeLimitMs / 1000) * (program.kind === 'project' ? 10 : 3), memory_limit: limits.memoryMb * 1024, enable_network: false }),
          signal: AbortSignal.timeout(Math.max(program.kind === 'project' ? 60_000 : 10_000, limits.timeLimitMs * 5)),
        });
        if (!res.ok) throw new Error(`judge answered ${res.status}`);
        const body = (await res.json()) as { stdout?: string | null; status?: { id: number; description: string }; time?: string | null; compile_output?: string | null };
        const statusId = body.status?.id ?? 0;
        // 3 = finished normally; we still compare ourselves so the verdict never depends on the judge's comparison
        const finished = statusId === 3 || statusId === 4;
        const passed = finished && sameOutput(body.stdout ?? '', t.expected);
        const verdict = passed ? 'passed' : statusId === 4 || (finished && !passed) ? 'wrong answer' : statusId === 5 ? 'time limit exceeded' : statusId === 6 ? (program.kind === 'project' ? 'build failed' : 'compilation error') : (body.status?.description ?? 'error').toLowerCase();
        out.push({ index, passed, verdict, stdout: (body.stdout ?? '').slice(0, 2000), timeMs: body.time ? Math.round(Number(body.time) * 1000) : undefined, ...(statusId === 6 && body.compile_output ? { compileOutput: body.compile_output.slice(0, 4000) } : {}) });
        if (statusId === 6) {
          // nothing else can pass when it does not build
          for (let k = index + 1; k < tests.length; k++) out.push({ index: k, passed: false, verdict: out[index]!.verdict });
          break;
        }
      }
      return out;
    },
    async languages() {
      const res = await fetchImpl(`${base}/languages`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`judge answered ${res.status}`);
      return (await res.json()) as Array<{ id: number; name: string }>;
    },
  };
}

export function judgeFor(deps: AppDeps): Judge | null {
  return deps.judge ?? (deps.config.JUDGE_URL ? judge0(deps.config.JUDGE_URL, deps.config.JUDGE_TOKEN, fetch, deps.config.JUDGE_LANGUAGE_IDS) : null);
}

/** The judge's view of the catalogue: which languages this sandbox can run. */
export async function languageStatus(deps: AppDeps) {
  const judge = judgeFor(deps);
  const ids = judge0Ids(deps.config.JUDGE_LANGUAGE_IDS);
  let installed: Array<{ id: number; name: string }> | null = null;
  let error: string | null = null;
  if (judge?.languages) {
    try {
      installed = await judge.languages();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e).slice(0, 300);
    }
  }
  const byId = new Map((installed ?? []).map((l) => [l.id, l.name]));
  return {
    judge: !judge ? 'NOT_CONFIGURED' : error ? 'UNREACHABLE' : 'CONNECTED',
    error,
    projects: installed ? byId.has(JUDGE0_MULTI_FILE) : null,
    languages: CODE_LANGUAGE_CATALOGUE.map((l) => ({ id: l.id, label: l.label, version: l.version, group: l.group, judge0: ids[l.id]!, installed: installed ? byId.has(ids[l.id]!) : null, sandboxName: byId.get(ids[l.id]!) ?? null })),
  };
}

export interface CodeSpecRow {
  languages?: string[];
  starter?: Record<string, string>;
  timeLimitMs?: number;
  memoryMb?: number;
  samples?: Array<{ input: string; expected: string }>;
  sampleRunsAllowed?: number;
  project?: CodeProject;
}
export interface CodeQuestionRow {
  question_id: string;
  kind: string;
  expected_answer: unknown;
  code_spec: CodeSpecRow | null;
  code_check?: unknown;
}
export interface CodeAnswer {
  language: CodeLanguage;
  source: string;
  files?: Record<string, string>;
}

export function hiddenTests(q: { expected_answer: unknown }): JudgeTest[] {
  const ea = (q.expected_answer ?? {}) as { tests?: unknown };
  return (Array.isArray(ea.tests) ? ea.tests : []).filter((t): t is JudgeTest => !!t && typeof (t as JudgeTest).input === 'string' && typeof (t as JudgeTest).expected === 'string');
}

/** The setter's reference solution (expectedAnswer.reference), if any. */
export function referenceOf(q: { expected_answer: unknown }): CodeAnswer | null {
  const r = ((q.expected_answer ?? {}) as { reference?: CodeAnswer }).reference;
  return r && typeof r.language === 'string' ? { language: r.language, source: r.source ?? '', ...(r.files ? { files: r.files } : {}) } : null;
}

/**
 * What actually runs for an answer. A project takes the setter's files and replaces only the editable ones with the
 * student's; anything else the student sends (other paths, read-only files) is ignored, so a student can never change
 * the harness, the tests or the build.
 */
export function programFor(spec: CodeSpecRow | null, code: CodeAnswer): Program {
  if (spec?.project) {
    const files: Record<string, string> = {};
    for (const f of spec.project.files) files[f.path] = f.editable && typeof code.files?.[f.path] === 'string' ? code.files[f.path]! : f.content;
    return { kind: 'project', language: code.language, files, build: spec.project.build ?? null, run: spec.project.run };
  }
  return { kind: 'single', language: code.language, source: code.source };
}

/** Identifies the program a student submitted (for "already graded this exact program"). */
export function answerFingerprint(spec: CodeSpecRow | null, code: CodeAnswer): string {
  if (!spec?.project) return sha256Hex(`${code.language}\n${code.source}`);
  const editable = spec.project.files.filter((f) => f.editable).map((f) => [f.path, code.files?.[f.path] ?? null]);
  return sha256Hex(`${code.language}\n${JSON.stringify(editable)}`);
}

export function hasProgram(spec: CodeSpecRow | null, code: CodeAnswer | undefined): code is CodeAnswer {
  if (!code?.language) return false;
  if (spec?.project) return spec.project.files.some((f) => f.editable && (code.files?.[f.path] ?? '').trim() !== '');
  return !!code.source?.trim();
}

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v ?? null);
/** A CODE question as it stands (spec, hidden tests, reference): any edit changes it, so an old check no longer counts. */
export function questionFingerprint(q: { code_spec: unknown; expected_answer: unknown }): string {
  return sha256Hex(stable({ spec: q.code_spec ?? null, tests: hiddenTests(q), reference: referenceOf(q) }));
}

function codeBlock(content: unknown): CodeAnswer | undefined {
  const c = typeof content === 'string' ? JSON.parse(content) : content;
  return ((c?.blocks ?? []) as Array<{ kind: string; content: CodeAnswer }>).find((b) => b.kind === 'code')?.content;
}

/** Queue a grading run for every CODE answer of a sealed script that has no run for its current program yet. */
export async function enqueueCodeGrading(trx: Knex.Transaction, tenantId: string, examId: string, attemptId: string): Promise<number> {
  const paper = await trx('question_papers').where({ tenant_id: tenantId, exam_id: examId, status: 'APPROVED' }).first('id');
  if (!paper) return 0;
  const codeQs = await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id, kind: 'CODE' }).select('question_id', 'code_spec');
  if (!codeQs.length) return 0;
  const specs = new Map(codeQs.map((q) => [q.question_id as string, (q.code_spec ?? null) as CodeSpecRow | null]));
  const docs = await trx('answer_documents').where({ tenant_id: tenantId, attempt_id: attemptId }).whereIn('question_id', [...specs.keys()]).select('question_id', 'content');
  let queued = 0;
  for (const d of docs) {
    const spec = specs.get(d.question_id) ?? null;
    const code = codeBlock(d.content);
    if (!hasProgram(spec, code)) continue;
    const hash = answerFingerprint(spec, code);
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
        return { examId: attempt.exam_id as string, q, code: codeBlock(doc?.content) };
      });
      examId = ctx.examId;
      const tests = hiddenTests(ctx.q);
      const spec = ctx.q.code_spec;
      if (!judge) outcome = { status: 'ERROR', error: 'no judge configured (JUDGE_URL)' };
      else if (!tests.length) outcome = { status: 'ERROR', error: 'the question has no hidden tests' };
      else if (!hasProgram(spec, ctx.code)) outcome = { status: 'ERROR', error: 'no program in the answer' };
      else if (spec?.languages && !spec.languages.includes(ctx.code.language)) outcome = { status: 'ERROR', error: `${ctx.code.language} is not a language this question allows` };
      else {
        const results = await judge.run(programFor(spec, ctx.code), tests, { timeLimitMs: spec?.timeLimitMs ?? 2000, memoryMb: spec?.memoryMb ?? 128 });
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
export async function runSampleTests(deps: AppDeps, tenantId: string, userId: string, attemptId: string, deviceSession: string | null, input: { questionId: string } & CodeAnswer) {
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
    if (spec.languages && !spec.languages.includes(input.language)) throw AppError.unprocessable('LANGUAGE_NOT_ALLOWED', `This question accepts ${spec.languages.map((l) => codeLanguage(l)?.label ?? l).join(', ')}`);
    if (!hasProgram(spec, input)) throw AppError.unprocessable('NOTHING_TO_RUN', spec.project ? 'Write something in the editable files first.' : 'Write your program first.');
    if (!judge) throw new AppError(503, 'JUDGE_UNAVAILABLE', 'Running code is not available for this exam; write your program and submit it as usual.');
    const used = await trx('code_runs').where({ tenant_id: tenantId, attempt_id: attemptId, question_id: input.questionId, purpose: 'SAMPLE' }).count<{ count: string }[]>('id as count');
    const allowed = spec.sampleRunsAllowed ?? 10;
    if (Number(used[0]?.count ?? 0) >= allowed) throw new AppError(429, 'SAMPLE_RUNS_EXHAUSTED', `All ${allowed} sample runs for this question are used; your program is still graded on the hidden tests after the exam.`);
    const [row] = await trx('code_runs').insert({ tenant_id: tenantId, attempt_id: attemptId, question_id: input.questionId, purpose: 'SAMPLE', language: input.language, source_sha256: answerFingerprint(spec, input), status: 'RUNNING', claimed_at: trx.fn.now(), attempts: 1 }).returning('id');
    return { runId: row.id as string, program: programFor(spec, input), samples: spec.samples ?? [], limits: { timeLimitMs: spec.timeLimitMs ?? 2000, memoryMb: spec.memoryMb ?? 128 }, remaining: allowed - Number(used[0]?.count ?? 0) - 1 };
  });
  let results: JudgeResult[] = [];
  let error: string | null = null;
  try {
    results = reserved.samples.length ? await judge!.run(reserved.program, reserved.samples, reserved.limits) : [];
  } catch (e) {
    error = String(e instanceof Error ? e.message : e).slice(0, 500);
  }
  await withTenantTx(deps.db, tenantId, (trx) => trx('code_runs').where('id', reserved.runId).update({ status: error ? 'ERROR' : 'DONE', results: JSON.stringify(results), passed_weight: results.filter((r) => r.passed).length, total_weight: reserved.samples.length, error, finished_at: trx.fn.now() }));
  return {
    runId: reserved.runId,
    remaining: reserved.remaining,
    error,
    results: results.map((r) => ({ test: r.index + 1, passed: r.passed, verdict: r.verdict, output: r.stdout ?? '', expected: reserved.samples[r.index]?.expected ?? '', ...(r.compileOutput ? { compileOutput: r.compileOutput } : {}) })),
  };
}

/**
 * The question setter's check: the reference solution is run against the visible samples and every hidden test.
 * The paper cannot be approved (while a judge is configured) until each CODE question with hidden tests has a passing
 * check of exactly its current version — a wrong expected output would otherwise cost every student marks.
 */
export async function checkCodeQuestion(deps: AppDeps, tenantId: string, actorId: string, examId: string, questionId: string, requestId?: string) {
  const judge = judgeFor(deps);
  const ctx = await withTenantTx(deps.db, tenantId, async (trx) => {
    const paper = await trx('question_papers').where({ tenant_id: tenantId, exam_id: examId }).orderBy('version', 'desc').first('id', 'status');
    if (!paper) throw AppError.notFound('PAPER_NOT_FOUND');
    if (paper.status === 'APPROVED') throw AppError.conflict('PAPER_APPROVED', 'The approved paper is sealed; edit a new version to change its questions.');
    const q = (await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id, question_id: questionId }).first('question_id', 'kind', 'expected_answer', 'code_spec')) as CodeQuestionRow | undefined;
    if (!q || q.kind !== 'CODE') throw AppError.notFound('QUESTION_NOT_FOUND', 'Not a coding question of this paper');
    return { paperId: paper.id as string, q };
  });
  const reference = referenceOf(ctx.q);
  if (!reference) throw AppError.unprocessable('REFERENCE_REQUIRED', 'Add your own solution (reference) to the answer key first: it is run against the tests to prove they are right.');
  const spec = ctx.q.code_spec;
  if (spec?.languages && !spec.languages.includes(reference.language)) throw AppError.unprocessable('LANGUAGE_NOT_ALLOWED', 'The reference must be in one of the question’s languages.');
  if (!judge) throw new AppError(503, 'JUDGE_UNAVAILABLE', 'No code sandbox is configured (JUDGE_URL); IT must set up Judge0 before coding questions can be checked.');
  const samples = (spec?.samples ?? []).map((s) => ({ ...s, weight: 1 }));
  const tests = [...samples, ...hiddenTests(ctx.q)];
  if (!tests.length) throw AppError.unprocessable('NO_TESTS', 'Add sample or hidden tests first.');
  const results = await judge.run(programFor(spec, reference), tests, { timeLimitMs: spec?.timeLimitMs ?? 2000, memoryMb: spec?.memoryMb ?? 128 });
  const rows = results.map((r) => ({ test: r.index + 1, kind: r.index < samples.length ? 'sample' : 'hidden', passed: r.passed, verdict: r.verdict, input: tests[r.index]!.input.slice(0, 500), expected: tests[r.index]!.expected.slice(0, 500), output: (r.stdout ?? '').slice(0, 500), ...(r.compileOutput ? { compileOutput: r.compileOutput } : {}) }));
  const check = { fingerprint: questionFingerprint(ctx.q), passed: rows.filter((r) => r.passed).length, total: tests.length, results: rows, checkedAt: new Date().toISOString(), checkedBy: actorId };
  await withTenantTx(deps.db, tenantId, async (trx) => {
    // only store it if the question did not change while the judge ran
    const now = (await trx('paper_questions').where({ tenant_id: tenantId, paper_id: ctx.paperId, question_id: questionId }).forNoKeyUpdate().first('code_spec', 'expected_answer')) as CodeQuestionRow | undefined;
    if (!now || questionFingerprint(now) !== check.fingerprint) throw AppError.conflict('QUESTION_CHANGED', 'The question was edited while it was being checked; check it again.');
    await trx('paper_questions').where({ tenant_id: tenantId, paper_id: ctx.paperId, question_id: questionId }).update({ code_check: JSON.stringify(check) });
    await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'paper.code_checked', entityType: 'question_paper', entityId: ctx.paperId, requestId, metadata: { examId, questionId, passed: check.passed, total: check.total } });
  });
  return { questionId, passed: check.passed, total: check.total, ok: check.passed === check.total, results: rows };
}

/** Approval gate: CODE questions with hidden tests whose current version has no passing reference check. */
export function uncheckedCodeQuestions(deps: AppDeps, questions: CodeQuestionRow[]): string[] {
  if (!judgeFor(deps)) return [];
  return questions
    .filter((q) => q.kind === 'CODE' && hiddenTests(q).length > 0)
    .filter((q) => {
      const c = (typeof q.code_check === 'string' ? JSON.parse(q.code_check) : q.code_check) as { fingerprint?: string; passed?: number; total?: number } | null;
      return !c || c.fingerprint !== questionFingerprint(q) || c.passed !== c.total;
    })
    .map((q) => q.question_id);
}
