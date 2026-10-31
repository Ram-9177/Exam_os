import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type express from 'express';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, answerHash, cleanScan, startFakeServer, type TestContext, type ProvisionedTenant } from './helpers.js';
import { runForensicsOnce } from '../src/modules/candidates/service.js';
import { runCodeJudgeOnce, judge0, sameOutput, type Judge } from '../src/modules/evaluation/judge.js';

/**
 * Coding, maths and multiple-answer questions end to end against the real database. The sandbox is replaced by an
 * in-process judge that "runs" a program by reading what it does from its source (doubling or not): the platform's
 * contract with the judge — what is sent, which tests, how results become proposals — is what is under test.
 */
const fakeJudge: Judge & { calls: Array<{ tests: number }> } = {
  calls: [],
  async run(_language, source, tests) {
    this.calls.push({ tests: tests.length });
    if (source.includes('syntax error')) return tests.map((_, index) => ({ index, passed: false, verdict: 'compilation error' }));
    return tests.map((t, index) => {
      const n = Number(t.input.trim());
      const out = source.includes('* 2') ? String(n * 2) : source.includes('+ n') && n < 100 ? String(n + n) : String(n);
      return { index, passed: sameOutput(out, t.expected), verdict: sameOutput(out, t.expected) ? 'passed' : 'wrong answer', stdout: out };
    });
  },
};

describe('coding, maths and multiple-answer questions', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let evaluator: Awaited<ReturnType<typeof createStaff>>;
  let examId = '';
  const S = { email: '', token: '', attemptId: '', device: '' };
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.1.1.1', 'User-Agent': 'ExamOS-Test/1.0' });
  const req = () => ctx.request();
  const save = (qid: string, blocks: Array<{ id: string; kind: string; content: unknown }>, baseRevision = 0) =>
    req()
      .put(`/api/v1/student/attempts/${S.attemptId}/answers/${qid}`)
      .set(H(S.token))
      .set('x-device-session', S.device)
      .send({ clientOperationId: randomUUID(), baseRevision, answerFormat: 'hybrid-v1', ops: blocks.map((b) => ({ op: 'upsert-block', blockId: b.id, kind: b.kind, content: b.content })), contentSha256: answerHash(blocks) });

  beforeAll(async () => {
    ctx = await createTestContext();
    ctx.deps.judge = fakeJudge;
    t = await provisionTenant(ctx, 'code');
    [examCell, evaluator] = await Promise.all([createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell'), createStaff(ctx, t, ['EVALUATOR'], 'evaluator')]);
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'CSE' }] });
    await K('courses').send({ rows: [{ code: 'CS101', name: 'Programming', departmentCode: 'CSE' }] });
    S.email = `s@${t.slug}.test`;
    await K('persons').send({ rows: [{ externalId: 'UOS-9001', kind: 'STUDENT', fullName: 'Coder', email: S.email }] });
    await K('enrollments').send({ rows: [{ studentExternalId: 'UOS-9001', courseCode: 'CS101', academicYear: '2026-27', term: 'ODD' }] });
    const token = await activationTokenFor(ctx, t.tenantId, S.email);
    await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password: 'Student-Passw0rd!2026' });
    S.token = (await req().post('/api/v1/auth/login').set('Host', t.host).send({ email: S.email, password: 'Student-Passw0rd!2026' })).body.accessToken;

    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'CS101-LAB', title: 'Programming lab', courseCode: 'CS101', examType: 'MID_1', academicYear: '2026-27', semester: 1, securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 3600_000).toISOString() });
    examId = create.body.examId;
    const paper = await req()
      .put(`/api/v1/exams/${examId}/paper`)
      .set(H(examCell.token))
      .send({
        title: 'Lab paper',
        sections: [{ code: 'A', title: 'Main' }],
        questions: [
          {
            questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'CODE', maxMarks: 10, attachments: [],
            prompt: { blocks: [{ id: 'p', kind: 'paragraph', content: 'Read n and print 2n.' }] },
            codeSpec: { languages: ['python', 'c'], samples: [{ input: '3', expected: '6' }], sampleRunsAllowed: 2, timeLimitMs: 1000, memoryMb: 64 },
            expectedAnswer: { tests: [{ input: '1', expected: '2' }, { input: '50', expected: '100' }, { input: '1000', expected: '2000', weight: 2 }] },
          },
          { questionId: 'Q2', sectionCode: 'A', number: 2, kind: 'MATH', maxMarks: 4, attachments: [], prompt: { blocks: [{ id: 'p', kind: 'paragraph', content: 'Expand (x+1)^2.' }] }, expectedAnswer: { expression: 'x^2+2x+1' } },
          { questionId: 'Q3', sectionCode: 'A', number: 3, kind: 'MCQ_MULTI', maxMarks: 2, attachments: [], prompt: { blocks: [{ id: 'p', kind: 'paragraph', content: 'Which are compiled languages?' }] }, options: [{ key: 'A', text: 'C' }, { key: 'B', text: 'Python' }, { key: 'C', text: 'C++' }, { key: 'D', text: 'Bash' }], expectedAnswer: ['A', 'C'] },
        ],
      });
    expect(paper.status).toBeLessThan(300);
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: ['UOS-9001'], provider: 'uos' });
    for (const step of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token));
    S.attemptId = (await req().get('/api/v1/student/me/exams').set(H(S.token))).body.exams[0].attemptId;
    const start = await req().post(`/api/v1/student/attempts/${S.attemptId}/prechecks`).set(H(S.token)).send({ clientBuild: 'chrome-130' });
    const runId = start.body.runId as string;
    const v = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(S.token)).send(body);
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
  afterAll(async () => ctx.close());

  it('students see the coding question with its samples and limits, never the hidden tests', async () => {
    const paper = await req().get(`/api/v1/student/attempts/${S.attemptId}/paper`).set(H(S.token));
    const q1 = paper.body.questions.find((q: { questionId: string }) => q.questionId === 'Q1');
    expect(q1.codeSpec).toMatchObject({ languages: ['python', 'c'], samples: [{ input: '3', expected: '6' }], sampleRunsAllowed: 2 });
    expect(JSON.stringify(paper.body)).not.toContain('2000'); // hidden test output
    expect(JSON.stringify(paper.body)).not.toContain('x^2+2x+1'); // the maths key
  });

  it('sample runs: only the visible samples, only in an allowed language, limited per question', async () => {
    const run = (language: string, source: string) => req().post(`/api/v1/student/attempts/${S.attemptId}/code-runs`).set(H(S.token)).set('x-device-session', S.device).send({ questionId: 'Q1', language, source });
    expect((await run('java', 'class A {}')).body.code).toBe('LANGUAGE_NOT_ALLOWED');
    const first = await run('python', 'n = int(input())\nprint(n + n)');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ remaining: 1, results: [{ test: 1, passed: true, verdict: 'passed', output: '6', expected: '6' }] });
    expect(fakeJudge.calls.at(-1)).toEqual({ tests: 1 }); // the sample only, never the hidden tests
    expect((await run('python', 'print(1)')).status).toBe(200);
    const third = await run('python', 'print(2)');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('SAMPLE_RUNS_EXHAUSTED');
    // not on a different device, not on a question that is not code
    expect((await req().post(`/api/v1/student/attempts/${S.attemptId}/code-runs`).set(H(S.token)).set('x-device-session', 'other').send({ questionId: 'Q1', language: 'python', source: 'x' })).status).toBe(409);
    expect((await req().post(`/api/v1/student/attempts/${S.attemptId}/code-runs`).set(H(S.token)).set('x-device-session', S.device).send({ questionId: 'Q2', language: 'python', source: 'x' })).status).toBe(404);
  });

  it('after the exam the hidden tests grade the program; maths and multiple-answer proposals follow the keys', async () => {
    // the program passes small inputs only (n + n is fine; the fake judge treats it as wrong from 100 upward)
    expect((await save('Q1', [{ id: 'k', kind: 'code', content: { language: 'python', source: 'n = int(input())\nprint(n + n)' } }])).status).toBe(200);
    expect((await save('Q2', [{ id: 'w', kind: 'paragraph', content: '(x+1)(x+1) by FOIL' }, { id: 'f', kind: 'final', content: { text: 'x² + 2x + 1' } }])).status).toBe(200);
    expect((await save('Q3', [{ id: 'c', kind: 'choice', content: { selected: ['A', 'C'] } }])).status).toBe(200);
    // a malformed code block is refused at the door
    expect((await save('Q1', [{ id: 'k2', kind: 'code', content: { language: 'brainfuck', source: '+' } }], 1)).body.code).toBe('ANSWER_INVALID');

    await req().post(`/api/v1/student/attempts/${S.attemptId}/submit`).set(H(S.token)).set('x-device-session', S.device).send({ idempotencyKey: randomUUID() });
    await req().post(`/api/v1/exams/${examId}/close`).set(H(examCell.token));
    await runForensicsOnce(ctx.deps);
    const queued = await ctx.admin('code_runs').where({ attempt_id: S.attemptId, purpose: 'GRADING' });
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('QUEUED');
    // before the judge has run, the coding question waits for the examiner
    let prop = await req().get(`/api/v1/candidates/${S.attemptId}/rubric-proposals`).set(H(evaluator.token));
    expect(prop.body.proposals.find((p: { questionId: string }) => p.questionId === 'Q1')).toMatchObject({ proposedMarks: null, method: 'EXAMINER' });

    expect(await runCodeJudgeOnce(ctx.deps)).toBe(1);
    const graded = await ctx.admin('code_runs').where({ attempt_id: S.attemptId, purpose: 'GRADING' }).first();
    expect(graded).toMatchObject({ status: 'DONE' });
    expect(Number(graded.passed_weight)).toBe(2); // tests 1 and 2 pass; the weight-2 test fails
    expect(Number(graded.total_weight)).toBe(4);
    prop = await req().get(`/api/v1/candidates/${S.attemptId}/rubric-proposals`).set(H(evaluator.token));
    const byQ = Object.fromEntries(prop.body.proposals.map((p: { questionId: string }) => [p.questionId, p]));
    expect(byQ['Q1']).toMatchObject({ proposedMarks: 5, method: 'CODE_TESTS', review: 'CHECK_CAREFULLY' });
    expect(byQ['Q2']).toMatchObject({ proposedMarks: 4, method: 'ANSWER_KEY' });
    expect(byQ['Q3']).toMatchObject({ proposedMarks: 2 });
    const snap = await ctx.admin('mark_proposals').where({ attempt_id: S.attemptId }).first();
    expect(Number(snap.proposed_total)).toBe(11); // the worker refreshed the queue snapshot after grading
    // re-running the evaluation does not run an unchanged program again
    await req().post(`/api/v1/exams/${examId}/auto-evaluate`).set(H(examCell.token));
    expect(await ctx.admin('code_runs').where({ attempt_id: S.attemptId, purpose: 'GRADING' })).toHaveLength(1);
  });

  it('the Judge0 adapter sends source, input and limits, compares output itself, and stops after a compilation error', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let n = 0;
    const server = await startFakeServer((app: express.Express) => {
      app.post('/submissions', (rq, rs) => {
        seen.push(rq.body);
        n++;
        if (n === 1) return rs.json({ stdout: '6\n', status: { id: 3, description: 'Accepted' }, time: '0.012' });
        if (n === 2) return rs.json({ stdout: '7', status: { id: 4, description: 'Wrong Answer' }, time: '0.01' });
        return rs.json({ stdout: null, status: { id: 6, description: 'Compilation Error' } });
      });
    });
    try {
      const judge = judge0(server.url, 'secret-token');
      const r1 = await judge.run('cpp', 'int main(){}', [{ input: '3', expected: '6' }, { input: '3', expected: '6' }], { timeLimitMs: 1000, memoryMb: 64 });
      expect(r1).toEqual([{ index: 0, passed: true, verdict: 'passed', stdout: '6\n', timeMs: 12 }, { index: 1, passed: false, verdict: 'wrong answer', stdout: '7', timeMs: 10 }]);
      expect(seen[0]).toMatchObject({ language_id: 54, source_code: 'int main(){}', stdin: '3', cpu_time_limit: 1, memory_limit: 65536, enable_network: false });
      const r2 = await judge.run('c', 'oops', [{ input: '1', expected: '1' }, { input: '2', expected: '2' }, { input: '3', expected: '3' }], { timeLimitMs: 1000, memoryMb: 64 });
      expect(r2.map((r) => r.verdict)).toEqual(['compilation error', 'compilation error', 'compilation error']);
      expect(n).toBe(3); // the remaining tests are not sent after a compilation error
    } finally {
      await server.close();
    }
  });
});
