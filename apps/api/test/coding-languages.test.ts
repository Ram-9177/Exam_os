import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type express from 'express';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, answerHash, cleanScan, startFakeServer, type TestContext, type ProvisionedTenant } from './helpers.js';
import { runForensicsOnce } from '../src/modules/candidates/service.js';
import { runCodeJudgeOnce, judge0, sameOutput, zipStore, type Judge, type Program } from '../src/modules/evaluation/judge.js';

/**
 * Every language, subject coding profiles and build-level (multi-file) questions, against the real database. The
 * sandbox is an in-process judge that "runs" a program by reading its files: what is under test is what ExamOS sends
 * (which files, whose build scripts) and what it does with the results.
 */
const programs: Program[] = [];
const fakeJudge: Judge = {
  async run(program, tests) {
    programs.push(program);
    const text = program.kind === 'single' ? program.source : Object.values(program.files).join('\n');
    if (text.includes('syntax error')) return tests.map((_, index) => ({ index, passed: false, verdict: 'build failed', compileOutput: 'Solution.java:1: error' }));
    return tests.map((t, index) => {
      const out = text.includes('n * 2') ? String(Number(t.input) * 2) : '0';
      return { index, passed: sameOutput(out, t.expected), verdict: sameOutput(out, t.expected) ? 'passed' : 'wrong answer', stdout: out };
    });
  },
  async languages() {
    return [
      { id: 62, name: 'Java (OpenJDK 13.0.1)' },
      { id: 78, name: 'Kotlin (1.3.70)' },
      { id: 89, name: 'Multi-file program' },
    ];
  },
};

const HARNESS = 'public class Main { public static void main(String[] a) { int n = new java.util.Scanner(System.in).nextInt(); System.out.println(Solution.solve(n)); } }';
const STUB = 'class Solution { static int solve(int n) { return 0; } }';
const SOLVED = 'class Solution { static int solve(int n) { return n * 2; } }';

/** Reads a stored zip (what zipStore writes) back into files, the way Judge0 unpacks additional_files. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

describe('every language, subject profiles and build-level questions', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let evaluator: Awaited<ReturnType<typeof createStaff>>;
  let examId = '';
  const S = { token: '', attemptId: '', device: '' };
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.1.1.1', 'User-Agent': 'ExamOS-Test/1.0' });
  const req = () => ctx.request();
  const paperBody = (overrides: { languages?: string[]; tests?: Array<{ input: string; expected: string }>; files?: Array<{ path: string; content: string; editable?: boolean }> } = {}) => ({
    title: 'Data structures lab',
    sections: [{ code: 'A', title: 'Main' }],
    questions: [
      {
        questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'CODE', maxMarks: 10, attachments: [],
        prompt: { blocks: [{ id: 'p', kind: 'paragraph', content: 'Complete Solution.solve so that it returns 2n.' }] },
        codeSpec: {
          languages: overrides.languages ?? ['java'],
          samples: [{ input: '3', expected: '6' }],
          sampleRunsAllowed: 3,
          project: { files: overrides.files ?? [{ path: 'Main.java', content: HARNESS }, { path: 'Solution.java', content: STUB, editable: true }], build: 'javac -d out *.java', run: 'java -cp out Main' },
        },
        expectedAnswer: { tests: overrides.tests ?? [{ input: '1', expected: '2' }, { input: '21', expected: '42' }], reference: { language: 'java', source: '', files: { 'Solution.java': SOLVED } } },
      },
    ],
  });
  const putPaper = (b: object) => req().put(`/api/v1/exams/${examId}/paper`).set(H(examCell.token)).send(b);
  const save = (qid: string, blocks: Array<{ id: string; kind: string; content: unknown }>, baseRevision = 0) =>
    req()
      .put(`/api/v1/student/attempts/${S.attemptId}/answers/${qid}`)
      .set(H(S.token))
      .set('x-device-session', S.device)
      .send({ clientOperationId: randomUUID(), baseRevision, answerFormat: 'hybrid-v1', ops: blocks.map((b) => ({ op: 'upsert-block', blockId: b.id, kind: b.kind, content: b.content })), contentSha256: answerHash(blocks) });

  beforeAll(async () => {
    ctx = await createTestContext();
    ctx.deps.judge = fakeJudge;
    t = await provisionTenant(ctx, 'langs');
    [examCell, evaluator] = await Promise.all([createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell'), createStaff(ctx, t, ['EVALUATOR'], 'evaluator')]);
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'CSE' }] });
    await K('courses').send({ rows: [{ code: 'CS201', name: 'Data Structures', departmentCode: 'CSE' }, { code: 'DS301', name: 'Data Science', departmentCode: 'CSE' }] });
    const email = `s@${t.slug}.test`;
    await K('persons').send({ rows: [{ externalId: 'UOS-9101', kind: 'STUDENT', fullName: 'Builder', email }] });
    await K('enrollments').send({ rows: [{ studentExternalId: 'UOS-9101', courseCode: 'CS201', academicYear: '2026-27', term: 'ODD' }] });
    const token = await activationTokenFor(ctx, t.tenantId, email);
    await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password: 'Student-Passw0rd!2026' });
    S.token = (await req().post('/api/v1/auth/login').set('Host', t.host).send({ email, password: 'Student-Passw0rd!2026' })).body.accessToken;
    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'CS201-LAB', title: 'Data structures lab', courseCode: 'CS201', examType: 'MID_1', academicYear: '2026-27', semester: 3, securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 3600_000).toISOString() });
    examId = create.body.examId;
  });
  afterAll(async () => ctx.close());

  it('the Examination Section sets which languages a subject uses; its coding questions can only allow those', async () => {
    // the catalogue and what this sandbox has installed
    const langs = await req().get('/api/v1/coding/languages').set(H(examCell.token));
    expect(langs.status).toBe(200);
    expect(langs.body.languages.length).toBeGreaterThanOrEqual(39);
    expect(langs.body).toMatchObject({ judge: 'CONNECTED', projects: true });
    const by = Object.fromEntries(langs.body.languages.map((l: { id: string }) => [l.id, l]));
    expect(by['java']).toMatchObject({ judge0: 62, installed: true, sandboxName: 'Java (OpenJDK 13.0.1)' });
    expect(by['python']).toMatchObject({ judge0: 71, installed: false });

    // only staff who manage exams set profiles; an unknown language or a default outside the list is refused
    const set = (token: string, code: string, profile: unknown) => req().put(`/api/v1/coding/subjects/${code}`).set(H(token)).send({ profile });
    expect((await set(evaluator.token, 'CS201', { languages: ['java'] })).status).toBe(403);
    expect((await set(examCell.token, 'CS201', { languages: ['java', 'cobra'] })).status).toBe(400);
    expect((await set(examCell.token, 'CS201', { languages: ['java'], default: 'python' })).status).toBe(400);
    expect((await set(examCell.token, 'NOPE1', { languages: ['java'] })).status).toBe(404);
    const ok = await set(examCell.token, 'CS201', { languages: ['java', 'kotlin', 'cpp'], default: 'java' });
    expect(ok.status).toBe(200);
    expect(ok.body.profile).toEqual({ languages: ['java', 'kotlin', 'cpp'], default: 'java' });
    expect((await set(examCell.token, 'DS301', { languages: ['python', 'r', 'sql'] })).body.profile.default).toBe('python');
    const subjects = await req().get('/api/v1/coding/subjects').set(H(evaluator.token));
    expect(subjects.body.subjects.find((s: { code: string }) => s.code === 'DS301').profile.languages).toEqual(['python', 'r', 'sql']);
    expect(await ctx.admin('audit_events').where({ tenant_id: t.tenantId, action: 'course.code_profile_set' })).toHaveLength(2);

    // the paper editor offers this exam's subject languages, in catalogue order
    const forExam = await req().get(`/api/v1/exams/${examId}/code-languages`).set(H(examCell.token));
    expect(forExam.body.subject).toMatchObject({ code: 'CS201', restricted: true });
    expect(forExam.body.languages.map((l: { id: string }) => l.id)).toEqual(['c', 'cpp', 'java', 'kotlin'].filter((l) => l !== 'c'));
    expect(forExam.body.default).toBe('java');

    // a question may not allow a language outside the subject
    const refused = await putPaper(paperBody({ languages: ['python'] }));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('LANGUAGE_NOT_IN_SUBJECT');
    // nor may a project file use a reserved script name or escape the project folder
    expect((await putPaper(paperBody({ files: [{ path: 'run', content: 'x', editable: true }] }))).status).toBe(400);
    expect((await putPaper(paperBody({ files: [{ path: '../Main.java', content: 'x', editable: true }] }))).status).toBe(400);
    expect((await putPaper(paperBody({ files: [{ path: 'Main.java', content: HARNESS }] }))).status).toBe(400); // nothing editable
  });

  it('the setter proves the hidden tests with a reference solution; a wrong test or an edit blocks approval', async () => {
    // a mistake in the key: 21 → 43
    expect((await putPaper(paperBody({ tests: [{ input: '1', expected: '2' }, { input: '21', expected: '43' }] }))).status).toBe(200);
    const bad = await req().post(`/api/v1/exams/${examId}/paper/questions/Q1/check-code`).set(H(examCell.token));
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, passed: 2, total: 3 });
    expect(bad.body.results[2]).toMatchObject({ kind: 'hidden', passed: false, input: '21', expected: '43', output: '42' });
    // the reference ran as a project: the setter's harness plus the reference's Solution.java, with the setter's scripts
    expect(programs.at(-1)).toMatchObject({ kind: 'project', language: 'java', build: 'javac -d out *.java', run: 'java -cp out Main', files: { 'Main.java': HARNESS, 'Solution.java': SOLVED } });
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));
    const refused = await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(examCell.token));
    expect(refused.body.code).toBe('CODE_NOT_CHECKED');

    // fixing the key makes the old check stale; a new check passes; saving the unchanged paper keeps it
    expect((await putPaper(paperBody())).status).toBe(200);
    let staff = await req().get(`/api/v1/exams/${examId}/paper`).set(H(examCell.token));
    expect(staff.body.paper.questions[0].codeCheck).toMatchObject({ passed: 2, total: 3, current: false });
    expect((await req().post(`/api/v1/exams/${examId}/paper/questions/Q1/check-code`).set(H(examCell.token))).body).toMatchObject({ ok: true, passed: 3, total: 3 });
    expect((await putPaper(paperBody())).status).toBe(200);
    staff = await req().get(`/api/v1/exams/${examId}/paper`).set(H(examCell.token));
    expect(staff.body.paper.questions[0].codeCheck).toMatchObject({ passed: 3, total: 3, current: true });
    expect(await ctx.admin('audit_events').where({ tenant_id: t.tenantId, action: 'paper.code_checked' })).toHaveLength(2);

    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: ['UOS-9101'], provider: 'uos' });
    for (const step of ['paper/submit-for-review', 'paper/approve', 'submit-for-review', 'approve', 'schedule', 'open-precheck']) expect([step, (await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token))).status]).toEqual([step, 200]);
    // the approved paper is sealed: no more checks on it
    expect((await req().post(`/api/v1/exams/${examId}/paper/questions/Q1/check-code`).set(H(examCell.token))).body.code).toBe('PAPER_APPROVED');

    S.attemptId = (await req().get('/api/v1/student/me/exams').set(H(S.token))).body.exams[0].attemptId;
    const start = await req().post(`/api/v1/student/attempts/${S.attemptId}/prechecks`).set(H(S.token)).send({ clientBuild: 'chrome-130' });
    const runId = start.body.runId as string;
    const v = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(S.token)).send(b);
    await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'for i in range(10): print(i * 2), done!' });
    await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(S.token)).send({ contentDigest: 'a'.repeat(64) });
    await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    expect((await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(S.token))).body.status).toBe('READY');
    await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));
    const g = await req().post(`/api/v1/student/attempts/${S.attemptId}/entry-grants`).set(H(S.token));
    S.device = (await req().post(`/api/v1/student/attempts/${S.attemptId}/admit`).set(H(S.token)).send({ grantToken: g.body.grantToken })).body.deviceSessionId;
  });

  it('students see the project files and scripts, never the reference; they can change only the editable files', async () => {
    const paper = await req().get(`/api/v1/student/attempts/${S.attemptId}/paper`).set(H(S.token));
    const q1 = paper.body.questions[0];
    expect(q1.codeSpec.project.files).toEqual([
      { path: 'Main.java', content: HARNESS, editable: false },
      { path: 'Solution.java', content: STUB, editable: true },
    ]);
    expect(JSON.stringify(paper.body)).not.toContain('n * 2'); // the reference
    expect(JSON.stringify(paper.body)).not.toContain('"42"'); // a hidden test

    // a sample run with a tampered harness: the setter's Main.java is what runs
    const run = await req()
      .post(`/api/v1/student/attempts/${S.attemptId}/code-runs`)
      .set(H(S.token))
      .set('x-device-session', S.device)
      .send({ questionId: 'Q1', language: 'java', files: { 'Solution.java': SOLVED, 'Main.java': 'class Main { /* print 6 */ }', 'Extra.java': 'x' } });
    expect(run.status).toBe(200);
    expect(run.body.results).toEqual([expect.objectContaining({ test: 1, passed: true })]);
    expect(programs.at(-1)).toEqual({ kind: 'project', language: 'java', build: 'javac -d out *.java', run: 'java -cp out Main', files: { 'Main.java': HARNESS, 'Solution.java': SOLVED } });
    // empty editable files: nothing to run; another language than the subject's toolchain: refused
    expect((await req().post(`/api/v1/student/attempts/${S.attemptId}/code-runs`).set(H(S.token)).set('x-device-session', S.device).send({ questionId: 'Q1', language: 'java', files: { 'Solution.java': '  ' } })).body.code).toBe('NOTHING_TO_RUN');
    expect((await req().post(`/api/v1/student/attempts/${S.attemptId}/code-runs`).set(H(S.token)).set('x-device-session', S.device).send({ questionId: 'Q1', language: 'kotlin', files: { 'Solution.java': SOLVED } })).body.code).toBe('LANGUAGE_NOT_ALLOWED');
    // a file path that escapes the project is refused when saving
    expect((await save('Q1', [{ id: 'k', kind: 'code', content: { language: 'java', source: '', files: { '../../etc/passwd': 'x' } } }])).body.code).toBe('ANSWER_INVALID');
  });

  it('after the exam the project is built and run on the hidden tests; the examiner sees every test', async () => {
    expect((await save('Q1', [{ id: 'k', kind: 'code', content: { language: 'java', source: '', files: { 'Solution.java': SOLVED } } }])).status).toBe(200);
    await req().post(`/api/v1/student/attempts/${S.attemptId}/submit`).set(H(S.token)).set('x-device-session', S.device).send({ idempotencyKey: randomUUID() });
    await req().post(`/api/v1/exams/${examId}/close`).set(H(examCell.token));
    await runForensicsOnce(ctx.deps);
    expect(await runCodeJudgeOnce(ctx.deps)).toBe(1);
    expect(programs.at(-1)).toMatchObject({ kind: 'project', files: { 'Main.java': HARNESS, 'Solution.java': SOLVED } });
    const prop = await req().get(`/api/v1/candidates/${S.attemptId}/rubric-proposals`).set(H(evaluator.token));
    const q1 = prop.body.proposals[0];
    expect(q1).toMatchObject({ proposedMarks: 10, method: 'CODE_TESTS', review: 'ROUTINE' });
    expect(q1.tests).toEqual([expect.objectContaining({ test: 1, passed: true, input: '1', expected: '2', output: '2' }), expect.objectContaining({ test: 2, passed: true, input: '21', expected: '42', output: '42' })]);
  });

  it('the Judge0 adapter sends a project as a multi-file program: a zip of the files with the setter’s build and run scripts', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = await startFakeServer((app: express.Express) => {
      app.post('/submissions', (rq, rs) => {
        seen.push(rq.body);
        if (seen.length === 1) return rs.json({ stdout: '6\n', status: { id: 3, description: 'Accepted' } });
        return rs.json({ stdout: null, status: { id: 6, description: 'Compilation Error' }, compile_output: 'Solution.java:1: error: ; expected' });
      });
      app.get('/languages', (_rq, rs) => rs.json([{ id: 89, name: 'Multi-file program' }]));
    });
    try {
      const judge = judge0(server.url, undefined, fetch, '{"python":92}');
      const project: Program = { kind: 'project', language: 'java', files: { 'Main.java': HARNESS, 'src/Solution.java': SOLVED }, build: 'javac -d out Main.java src/Solution.java', run: 'java -cp out Main' };
      expect(await judge.run(project, [{ input: '3', expected: '6' }], { timeLimitMs: 1000, memoryMb: 256 })).toEqual([expect.objectContaining({ passed: true, verdict: 'passed' })]);
      expect(seen[0]).toMatchObject({ language_id: 89, stdin: '3', cpu_time_limit: 1, wall_time_limit: 10, memory_limit: 262144, enable_network: false });
      expect(seen[0]!['source_code']).toBeUndefined();
      expect(unzip(Buffer.from(String(seen[0]!['additional_files']), 'base64'))).toEqual({ 'Main.java': HARNESS, 'src/Solution.java': SOLVED, compile: 'javac -d out Main.java src/Solution.java\n', run: 'java -cp out Main\n' });
      const failed = await judge.run({ ...project, files: { 'Main.java': 'syntax error' } }, [{ input: '1', expected: '2' }, { input: '2', expected: '4' }], { timeLimitMs: 1000, memoryMb: 256 });
      expect(failed).toEqual([expect.objectContaining({ verdict: 'build failed', compileOutput: 'Solution.java:1: error: ; expected' }), expect.objectContaining({ verdict: 'build failed' })]);
      expect(seen).toHaveLength(2); // nothing more is sent once the build fails
      // a remapped language id (JUDGE_LANGUAGE_IDS) is used as configured
      await judge.run({ kind: 'single', language: 'python', source: 'print(6)' }, [{ input: '', expected: '6' }], { timeLimitMs: 1000, memoryMb: 64 }).catch(() => undefined);
      expect(seen[2]).toMatchObject({ language_id: 92, source_code: 'print(6)' });
      expect(await judge.languages!()).toEqual([{ id: 89, name: 'Multi-file program' }]);
    } finally {
      await server.close();
    }
    // the zip is a real zip: same bytes for the same files, readable entry by entry
    expect(zipStore({ a: '1' }).equals(zipStore({ a: '1' }))).toBe(true);
    expect(unzip(zipStore({ 'ü/ñ.txt': 'héllo', b: '' }))).toEqual({ 'ü/ñ.txt': 'héllo', b: '' });
  });
});
