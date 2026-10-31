import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, adminAsController, createApiKey, activationTokenFor, startFakeServer, runWorkers, answerHash, cleanScan, type TestContext, type ProvisionedTenant } from './helpers.js';
import { runForensicsOnce } from '../src/modules/candidates/service.js';

interface Student {
  externalId: string;
  email: string;
  token: string;
  userId: string;
  attemptId: string;
}

/**
 * The vertical slice the spec calls the first release milestone (§22, §36,
 * Part III "Definition of done"), executed end to end against the real
 * database with the race conditions the spec names explicitly.
 */
describe('end-to-end exam flow', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let chief: Awaited<ReturnType<typeof createStaff>>;
  let evaluator: Awaited<ReturnType<typeof createStaff>>;
  let controller: Awaited<ReturnType<typeof createStaff>>;
  let erpKey: { apiKey: string };
  let receiver: { url: string; close: () => Promise<void> };
  const erpEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  let examId = '';
  const A: Student = { externalId: 'UOS-3001', email: '', token: '', userId: '', attemptId: '' };
  const B: Student = { externalId: 'UOS-3002', email: '', token: '', userId: '', attemptId: '' };
  let deviceA = '';
  let incidentIds: string[] = [];

  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'flow');
    // Four staff logins in total: admin/controller, examination section, chief proctor, examiner (also an ordinary proctor).
    [examCell, chief, evaluator] = await Promise.all([
      createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell'),
      createStaff(ctx, t, ['CHIEF_PROCTOR'], 'chief'),
      createStaff(ctx, t, ['EVALUATOR', 'PROCTOR'], 'evaluator'),
    ]);
    controller = adminAsController(t);
    erpKey = await createApiKey(ctx, t, ['roster:write', 'roster:read', 'events:read', 'results:read', 'webhooks:manage']);
    receiver = await startFakeServer((app) => {
      app.post('/erp', (r, res) => {
        erpEvents.push(r.body);
        res.status(200).end();
      });
    });
    const hook = await req().post('/api/v1/integration/v1/webhooks').set('Authorization', `Bearer ${erpKey.apiKey}`).send({ url: `${receiver.url}/erp`, eventTypes: ['attempt.submitted', 'result.published', 'result.corrected', 'candidate.held', 'exam.scheduled'] });
    expect(hook.status).toBe(201);

    // roster from the ERP
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${erpKey.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    expect((await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'CSE', parentCode: 'SOE' }, { kind: 'PROGRAMME', code: 'BTECH-CSE', name: 'B.Tech CSE', parentCode: 'CSE' }] })).status).toBe(200);
    expect((await K('courses').send({ rows: [{ code: 'CS301', name: 'Operating Systems', departmentCode: 'CSE' }] })).status).toBe(200);
    A.email = `asha@${t.slug}.test`;
    B.email = `bala@${t.slug}.test`;
    const persons = await K('persons').send({
      rows: [
        { externalId: A.externalId, kind: 'STUDENT', fullName: 'Asha Rao', email: A.email, departmentCode: 'CSE', programmeCode: 'BTECH-CSE', currentSemester: 5, section: 'A', attributes: { registerNumber: '22CSE001' } },
        { externalId: B.externalId, kind: 'STUDENT', fullName: 'Bala K', email: B.email, departmentCode: 'CSE', programmeCode: 'BTECH-CSE', currentSemester: 5, section: 'A', attributes: { registerNumber: '22CSE002' } },
        { externalId: 'UOS-3003', kind: 'STUDENT', fullName: 'Not Enrolled', email: `ne@${t.slug}.test` },
      ],
    });
    expect(persons.body.summary.created).toBe(3);
    expect((await K('enrollments').send({ rows: [A, B].map((s) => ({ studentExternalId: s.externalId, courseCode: 'CS301', academicYear: '2026-27', term: 'ODD', section: 'A' })) })).body.summary.created).toBe(2);
    for (const s of [A, B]) {
      const token = await activationTokenFor(ctx, t.tenantId, s.email);
      const act = await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password: 'Student-Passw0rd!2026' });
      expect(act.status).toBe(200);
      s.token = act.body.accessToken;
      s.userId = act.body.user.id;
    }
  });
  afterAll(async () => {
    await receiver.close();
    await ctx.close();
  });

  it('Exam Cell creates a SECURE_BYOD exam, allocates eligible students only, and issues hall tickets', async () => {
    const start = new Date(Date.now() - 10 * 60_000);
    const end = new Date(Date.now() + 3 * 3600_000);
    const create = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({ code: 'CS301-MID1', title: 'Operating Systems — Mid 1', courseCode: 'CS301', examType: 'MID_1', academicYear: '2026-27', semester: 5, maxMarks: 20, securityProfile: 'BYOD_STRICT', durationMinutes: 60, windowStartAt: start.toISOString(), windowEndAt: end.toISOString(), policy: { allowedClientBuilds: ['seb-3.8.0'] } });
    expect(create.status).toBe(201);
    examId = create.body.examId;
    const stored = await ctx.admin('exams').where('id', examId).first();
    expect(stored.security_profile).toBe('SECURE_BYOD'); // alias normalised (review §3)

    const alloc = await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: [A.externalId, B.externalId, 'UOS-3003', 'UOS-NOPE'], provider: 'uos' });
    expect(alloc.status).toBe(200);
    expect(alloc.body.allocated).toBe(2);
    expect(alloc.body.skipped.map((s: { reason: string }) => s.reason).sort()).toEqual(['NOT_ELIGIBLE_FOR_COURSE', 'STUDENT_NOT_FOUND']);

    const ht = await req().post(`/api/v1/exams/${examId}/hall-tickets`).set(H(examCell.token)).send({});
    expect(ht.status).toBe(200);
    expect(ht.body.issued).toBe(2);
    // students never see draft exams; the exam appears once scheduled
    const hidden = await req().get('/api/v1/student/me/exams').set(H(A.token));
    expect(hidden.body.exams.length).toBe(0);
    // Phase 1: create and approve paper with total_marks == 20 matching exam.maxMarks
    await req().put(`/api/v1/exams/${examId}/paper`).set(H(examCell.token)).send({
      title: 'Operating Systems — Mid 1 Question Paper',
      sections: [{ code: 'A', title: 'Main', instructions: 'Answer both questions' }],
      questions: [
        {
          questionId: 'Q1',
          sectionCode: 'A',
          number: 1,
          kind: 'DESCRIPTIVE',
          prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Define a process and describe its states.' }] },
          maxMarks: 10,
          rubric: [{ code: 'CONCEPT', max: 5, description: 'Concept' }, { code: 'DIAGRAM', max: 5, description: 'Diagram' }],
          attachments: [],
        },
        {
          questionId: 'Q2',
          sectionCode: 'A',
          number: 2,
          kind: 'DESCRIPTIVE',
          prompt: { blocks: [{ id: 'p2', kind: 'paragraph', content: 'Explain deadlock prevention methods.' }] },
          maxMarks: 10,
          rubric: [{ code: 'EXPL', max: 10, description: 'Deadlock explanation', keywords: ['prevention', 'hold and wait|hold-and-wait', 'circular wait', 'line'] }],
          attachments: [],
        },
      ],
    });
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(examCell.token));

    for (const step of ['submit-for-review', 'approve', 'schedule']) {
      const r = await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token));
      expect(r.status, step).toBe(200);
    }
    const mine = await req().get('/api/v1/student/me/exams').set(H(A.token));
    expect(mine.status).toBe(200);
    expect(mine.body.exams[0].hallTicketNumber).toBe('CS301-MID1-0001');
    expect(mine.body.exams[0].attemptStatus).toBe('ALLOCATED');
    A.attemptId = mine.body.exams[0].attemptId;
    const mineB = await req().get('/api/v1/student/me/exams').set(H(B.token));
    B.attemptId = mineB.body.exams[0].attemptId;
    // students cannot see staff routes
    expect((await req().get(`/api/v1/exams/${examId}/readiness`).set(H(A.token))).status).toBe(403);
  });

  it('nothing starts on a timer: readiness check is refused until the Examination Section opens it', async () => {
    const early = await req().post(`/api/v1/student/attempts/${A.attemptId}/prechecks`).set(H(A.token)).send({ clientBuild: 'seb-3.8.0' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('PRECHECK_NOT_OPEN');
    const open = await req().post(`/api/v1/exams/${examId}/open-precheck`).set(H(examCell.token));
    expect(open.status).toBe(200);
    const illegal = await req().post(`/api/v1/exams/${examId}/approve`).set(H(examCell.token));
    expect(illegal.status).toBe(409);
    expect(illegal.body.code).toBe('ILLEGAL_TRANSITION');
    await runWorkers(ctx);
    expect(erpEvents.some((e) => e.type === 'exam.scheduled')).toBe(true);
  });

  it('student A completes the 15-minute readiness check; speed is never measured and stylus is optional', async () => {
    const start = await req().post(`/api/v1/student/attempts/${A.attemptId}/prechecks`).set(H(A.token)).send({ clientBuild: 'seb-3.8.0' });
    expect(start.status).toBe(201);
    const runId = start.body.runId as string;
    const codes = Object.fromEntries(start.body.checks.map((c: { code: string; status: string }) => [c.code, c.status]));
    expect(codes).toMatchObject({ IDENTITY_SESSION: 'PASS', ELIGIBILITY: 'PASS', CONSENT: 'REMEDIATE' });

    const verify = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(A.token)).send(body);
    // server-measured items cannot be self-declared
    expect((await verify({ code: 'ELIGIBILITY' })).status).toBe(400);
    expect((await verify({ code: 'CLIENT_VERSION', clientBuild: 'seb-3.8.0' })).status).toBe(200);
    expect((await verify({ code: 'CLOCK_SYNC', clientClockMs: Date.now() + 5000 })).status).toBe(200);
    const slowTypist = await verify({ code: 'KEYBOARD_INPUT', keyboardSample: 'The quick brown fox, 2026; jumps (over) the lazy dog!' });
    expect(slowTypist.status).toBe(200);
    // system scan: the client sends raw settings only; the server derives the findings
    expect((await verify({ code: 'SYSTEM_SCAN' })).status).toBe(400);
    const dual = await verify({ code: 'SYSTEM_SCAN', scan: cleanScan({ screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, isExtended: true, displayCount: 2 }, verdict: 'CLEAN' }) });
    expect(dual.body.checks.find((c: { code: string }) => c.code === 'SYSTEM_SCAN')).toMatchObject({ status: 'REMEDIATE', diagnosticCode: 'MULTIPLE_DISPLAYS', remediationCode: 'FIX_DEVICE_SETTINGS' });
    const clean = await verify({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    expect(clean.body.checks.find((c: { code: string }) => c.code === 'SYSTEM_SCAN')).toMatchObject({ status: 'PASS', source: 'CLIENT_DECLARED' });
    const scans = await ctx.admin('device_scans').where({ attempt_id: A.attemptId }).orderBy('created_at');
    expect(scans.map((r) => r.verdict)).toEqual(['BLOCKED', 'CLEAN']);
    expect(scans[0].ip).toBeTruthy();
    const noNet = await verify({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    expect(noNet.body.checks.find((c: { code: string }) => c.code === 'NETWORK_SAVE_ROUNDTRIP').status).toBe('REMEDIATE');
    const ps = await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(A.token)).send({ contentDigest: 'a'.repeat(64) });
    expect(ps.status).toBe(200);
    expect(ps.body.revision).toBe(1);
    expect((await verify({ code: 'NETWORK_SAVE_ROUNDTRIP' })).body.checks.find((c: { code: string }) => c.code === 'NETWORK_SAVE_ROUNDTRIP').status).toBe('PASS');
    // stylus/canvas: optional — a failed drawing test never blocks readiness
    const canvas = await verify({ code: 'CANVAS_INPUT', canvasOps: 1 });
    expect(canvas.body.checks.find((c: { code: string }) => c.code === 'CANVAS_INPUT')).toMatchObject({ status: 'REMEDIATE', optional: true });
    expect((await verify({ code: 'CONSENT', consentPolicyVersion: 'wrong' })).status).toBe(400);
    const exam = await ctx.admin('exams').where('id', examId).first('policy_version');
    expect((await verify({ code: 'CONSENT', consentPolicyVersion: exam.policy_version })).status).toBe(200);
    const camera = await verify({ code: 'CAMERA' });
    expect(camera.body.checks.find((c: { code: string }) => c.code === 'CAMERA').status).toBe('UNVERIFIABLE'); // honest until the media pipeline exists

    const fin = await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(A.token));
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('READY');
    expect(fin.body.examTimerStarted).toBe(false);
    expect(fin.body.checks.find((c: { code: string }) => c.code === 'KEYBOARD_INPUT').instruction).toBe('Ready');
    const consents = await ctx.admin('consent_records').where({ tenant_id: t.tenantId, user_id: A.userId, exam_id: examId });
    expect(consents.map((c) => c.purpose).sort()).toEqual(['CAMERA', 'MICROPHONE']);
  });

  it('student B fails the secure-client check; the readiness board shows why; only a Controller may waive a security check', async () => {
    const start = await req().post(`/api/v1/student/attempts/${B.attemptId}/prechecks`).set(H(B.token)).send({ clientBuild: 'chrome-130' });
    const runId = start.body.runId;
    const v = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(B.token)).send(body);
    await v({ code: 'CLIENT_VERSION', clientBuild: 'chrome-130' });
    await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Sample text with digits 123 and punctuation, done!' });
    await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(B.token)).send({ contentDigest: 'b'.repeat(64) });
    await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    const exam = await ctx.admin('exams').where('id', examId).first('policy_version');
    await v({ code: 'CONSENT', consentPolicyVersion: exam.policy_version });
    const fin = await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(B.token));
    expect(fin.body.status).toBe('REMEDIATE');
    expect(fin.body.helpAction).toBe('FIX_AND_RETRY');

    const board = await req().get(`/api/v1/exams/${examId}/readiness`).set(H(examCell.token));
    expect(board.status).toBe(200);
    expect(board.body.summary).toMatchObject({ total: 2, ready: 1, needsFix: 1 });
    const rowB = board.body.candidates.find((c: { attemptId: string }) => c.attemptId === B.attemptId);
    expect(rowB.blocking).toEqual(['CLIENT_VERSION']);
    const check = rowB.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION');
    expect(check.securityRelevant).toBe(true);
    expect(check.instruction).toContain('approved exam client');

    const cellTry = await req().post(`/api/v1/exams/${examId}/attempts/${B.attemptId}/admission-exceptions`).set(H(examCell.token)).send({ exceptionCode: 'TECH_ALT_DEVICE', coversChecks: ['CLIENT_VERSION'], reason: 'Loaner laptop issued at desk 3, invigilator present' });
    expect(cellTry.status).toBe(403);
    expect(cellTry.body.code).toBe('SECURITY_OVERRIDE_REQUIRED');
    const ctrl = await req().post(`/api/v1/exams/${examId}/attempts/${B.attemptId}/admission-exceptions`).set(H(controller.token)).send({ exceptionCode: 'TECH_ALT_DEVICE', coversChecks: ['CLIENT_VERSION'], reason: 'Loaner laptop issued at desk 3, invigilator present' });
    expect(ctrl.status).toBe(201);
    // re-run readiness: the exception covers the failing check
    const again = await req().post(`/api/v1/student/attempts/${B.attemptId}/prechecks`).set(H(B.token)).send({ clientBuild: 'chrome-130' });
    const r2 = again.body.runId;
    const v2 = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${r2}/items/verify`).set(H(B.token)).send(body);
    await v2({ code: 'CLIENT_VERSION', clientBuild: 'chrome-130' });
    await v2({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await v2({ code: 'KEYBOARD_INPUT', keyboardSample: 'Sample text with digits 123 and punctuation, done!' });
    await v2({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    await req().post(`/api/v1/student/prechecks/${r2}/practice-saves`).set(H(B.token)).send({ contentDigest: 'b'.repeat(64) });
    await v2({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    await v2({ code: 'CONSENT', consentPolicyVersion: exam.policy_version });
    const fin2 = await req().post(`/api/v1/student/prechecks/${r2}/finalize`).set(H(B.token));
    expect(fin2.body.status).toBe('READY');
    expect(fin2.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION').coveredByException).toBe(true);
  });

  it('entry is refused until a human starts the exam; a grant is single-use even under a concurrent admit race', async () => {
    const lobby = await req().post(`/api/v1/student/attempts/${A.attemptId}/entry-grants`).set(H(A.token));
    expect(lobby.status).toBe(409);
    expect(lobby.body.code).toBe('EXAM_NOT_STARTED');
    const start = await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));
    expect(start.status).toBe(200);
    const grant = await req().post(`/api/v1/student/attempts/${A.attemptId}/entry-grants`).set(H(A.token));
    expect(grant.status).toBe(201);
    const results = await Promise.all(Array.from({ length: 6 }, () => req().post(`/api/v1/student/attempts/${A.attemptId}/admit`).set(H(A.token)).send({ grantToken: grant.body.grantToken })));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(1);
    expect(results.filter((r) => r.status !== 200).every((r) => ['GRANT_INVALID', 'ALREADY_ACTIVE'].includes(r.body.code))).toBe(true);
    deviceA = ok[0]!.body.deviceSessionId;
    expect(deviceA).toBeTruthy();
    const epochs = await ctx.admin('warning_epochs').where('attempt_id', A.attemptId);
    expect(epochs.length).toBe(1);
    const receipts = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'ADMISSION_RECEIPT', to_address: A.email });
    expect(receipts.length).toBe(1);
    const expired = await req().post(`/api/v1/student/attempts/${A.attemptId}/entry-grants`).set(H(A.token));
    expect(expired.status).toBe(409); // already ACTIVE, not READY
  });

  it('answers are versioned, idempotent, conflict-detecting, hash-verified and bound to one device', async () => {
    const q1 = `/api/v1/student/attempts/${A.attemptId}/answers/Q1`;
    const blocks1 = [{ id: 'b1', kind: 'paragraph', content: 'A process is a program in execution.' }];
    const op1 = randomUUID();
    const s1 = await req().put(q1).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: op1, baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: blocks1[0]!.content }], contentSha256: answerHash(blocks1) });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ accepted: true, serverRevision: 1, duplicate: false });
    // network retry of the same operation returns the same receipt
    const s1again = await req().put(q1).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: op1, baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: blocks1[0]!.content }], contentSha256: answerHash(blocks1) });
    expect(s1again.body).toMatchObject({ serverRevision: 1, duplicate: true, receiptId: s1.body.receiptId });
    // stale base revision is a conflict, never last-write-wins
    const stale = await req().put(q1).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: randomUUID(), baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b2', kind: 'paragraph', content: 'x' }], contentSha256: 'f'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REVISION_CONFLICT');
    // client/server document divergence is detected
    const blocks2 = [...blocks1, { id: 'b2', kind: 'canvas', content: { width: 100, height: 100, strokes: [{ tool: 'pen', width: 2, points: [[0, 0], [10, 10]] }] } }];
    const badHash = await req().put(q1).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: randomUUID(), baseRevision: 1, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b2', kind: 'canvas', content: blocks2[1]!.content }], contentSha256: 'e'.repeat(64) });
    expect(badHash.status).toBe(422);
    const s2 = await req().put(q1).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: randomUUID(), baseRevision: 1, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b2', kind: 'canvas', content: blocks2[1]!.content }], contentSha256: answerHash(blocks2) });
    expect(s2.body.serverRevision).toBe(2);
    const read = await req().get(q1).set(H(A.token));
    expect(read.body.serverRevision).toBe(2);
    expect(read.body.content.blocks.length).toBe(2);
    // second device: write refused, server-observed CONCURRENT_SESSION incident recorded (never auto-counted)
    const other = await req().put(q1).set(H(A.token)).set('x-device-session', randomUUID()).send({ clientOperationId: randomUUID(), baseRevision: 2, answerFormat: 'hybrid-v1', ops: [{ op: 'delete-block', blockId: 'b2' }], contentSha256: answerHash(blocks1) });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('DEVICE_SESSION_MISMATCH');
    const inc = await ctx.admin('proctor_incidents').where({ attempt_id: A.attemptId, signal_class: 'CONCURRENT_SESSION' }).first();
    expect(inc).toBeTruthy();
    expect(inc.priority).toBe(90);
    expect(inc.status).toBe('PROCTOR_REVIEW');
    const hb = await req().post(`/api/v1/student/attempts/${A.attemptId}/heartbeat`).set(H(A.token)).set('x-device-session', deviceA);
    expect(hb.status).toBe(200);
    expect(hb.body.status).toBe('ACTIVE');
  });

  it('raw signals are deduplicated and grouped; technical signals can never become warnings', async () => {
    const post = (events: unknown[]) => req().post('/api/v1/proctor/events').set(H(A.token)).send({ events });
    const base = { attemptId: A.attemptId, signalClass: 'FOCUS_LOST', metadata: {} };
    const r = await post([{ ...base, sourceEventId: 'f1' }, { ...base, sourceEventId: 'f2' }, { ...base, sourceEventId: 'f3' }, { ...base, sourceEventId: 'f1' }]);
    expect(r.status).toBe(202);
    const results = r.body.results as Array<{ incidentId: string; duplicate: boolean }>;
    expect(new Set(results.map((x) => x.incidentId)).size).toBe(1);
    expect(results[3]!.duplicate).toBe(true);
    const grouped = await ctx.admin('proctor_incidents').where('id', results[0]!.incidentId).first();
    expect(grouped.event_count).toBe(3);
    // cannot report for someone else's attempt
    expect((await req().post('/api/v1/proctor/events').set(H(B.token)).send({ events: [{ ...base, sourceEventId: 'x' }] })).status).toBe(403);
    const tech = await post([{ attemptId: A.attemptId, signalClass: 'CAMERA_UNAVAILABLE', sourceEventId: 'cam1', metadata: {} }]);
    const techIncident = tech.body.results[0].incidentId;
    const tryCount = await req().post(`/api/v1/proctor/incidents/${techIncident}/decision`).set(H(chief.token)).send({ action: 'CONFIRM_WARNING', reasonCode: 'X', idempotencyKey: randomUUID() });
    expect(tryCount.status).toBe(422);
    expect(tryCount.body.code).toBe('TECHNICAL_NOT_COUNTABLE');
    const queue = await req().get('/api/v1/proctor/incidents').set(H(chief.token)).query({ examId });
    expect(queue.status).toBe(200);
    expect(queue.body.incidents[0].signal_class).toBe('CONCURRENT_SESSION'); // highest priority first
    // students cannot read the queue
    expect((await req().get('/api/v1/proctor/incidents').set(H(A.token))).status).toBe(403);
  });

  it('the fifth validated warning suspends atomically even against concurrent saves; duplicate confirms never double-count', async () => {
    const classes = ['FULLSCREEN_EXIT', 'VISUAL_ANOMALY', 'OTHER_MANUAL', 'DISALLOWED_APP_DETECTED'];
    const created = await req().post('/api/v1/proctor/events').set(H(A.token)).send({ events: classes.map((c, i) => ({ attemptId: A.attemptId, signalClass: c, sourceEventId: `w${i}`, metadata: {} })) });
    incidentIds = created.body.results.map((x: { incidentId: string }) => x.incidentId);
    const focus = await ctx.admin('proctor_incidents').where({ attempt_id: A.attemptId, signal_class: 'FOCUS_LOST' }).first('id');
    incidentIds.push(focus.id);
    expect(incidentIds.length).toBe(5);

    const decide = (id: string, key = randomUUID()) => req().post(`/api/v1/proctor/incidents/${id}/decision`).set(H(chief.token)).send({ action: 'CONFIRM_WARNING', reasonCode: 'POLICY_VIOLATION_REVIEWED', notes: 'observed by invigilator', idempotencyKey: key });
    for (let i = 0; i < 4; i++) {
      const d = await decide(incidentIds[i]!);
      expect(d.status).toBe(200);
      expect(d.body.epoch.confirmedCount).toBe(i + 1);
      expect(d.body.attemptStatus).toBe('ACTIVE');
    }
    // repeated confirm of the same incident in the same epoch is a no-op; idempotent replay returns the same decision
    const k = randomUUID();
    const again = await decide(incidentIds[0]!, k);
    expect(again.body.epoch.confirmedCount).toBe(4);
    const replay = await decide(incidentIds[0]!, k);
    expect(replay.body.decisionId).toBe(again.body.decisionId);

    // race: fifth confirm vs 12 concurrent saves
    const q2 = `/api/v1/student/attempts/${A.attemptId}/answers/Q2`;
    let rev = 0;
    let blocks: Array<{ id: string; kind: string; content: unknown }> = [];
    const saveOnce = (i: number) => {
      const next = [...blocks, { id: `p${i}`, kind: 'paragraph', content: `line ${i}` }];
      return req().put(q2).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: randomUUID(), baseRevision: rev, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: `p${i}`, kind: 'paragraph', content: `line ${i}` }], contentSha256: answerHash(next) });
    };
    // warm one accepted save so Q2 exists
    const warm = await saveOnce(0);
    expect(warm.status).toBe(200);
    rev = 1;
    blocks = [{ id: 'p0', kind: 'paragraph', content: 'line 0' }];
    const fifth = decide(incidentIds[4]!);
    const saves = Promise.all(Array.from({ length: 12 }, (_, i) => saveOnce(i + 1)));
    const [d5, saveResults] = await Promise.all([fifth, saves]);
    expect(d5.status).toBe(200);
    expect(d5.body.attemptStatus).toBe('SUSPENDED');
    expect(d5.body.suspensionKind).toBe('WARNING_THRESHOLD');
    expect(d5.body.epoch.confirmedCount).toBe(5);
    const accepted = saveResults.filter((r) => r.status === 200);
    const refused = saveResults.filter((r) => r.status !== 200);
    // concurrent saves with the same base revision: at most one can win a revision; after suspension all are refused
    expect(accepted.length).toBeLessThanOrEqual(1);
    expect(refused.every((r) => ['REVISION_CONFLICT', 'ATTEMPT_NOT_ACTIVE'].includes(r.body.code))).toBe(true);
    const attempt = await ctx.admin('exam_attempts').where('id', A.attemptId).first();
    expect(attempt.status).toBe('SUSPENDED');
    const doc = await ctx.admin('answer_documents').where({ attempt_id: A.attemptId, question_id: 'Q2' }).first();
    const revisions = await ctx.admin('answer_revisions').where({ attempt_id: A.attemptId, question_id: 'Q2' });
    expect(revisions.length).toBe(doc.current_revision); // ledger == document, nothing lost, nothing phantom
    const postSuspend = await saveOnce(99);
    expect(postSuspend.status).toBe(409);
    expect(postSuspend.body.code).toBe('ATTEMPT_NOT_ACTIVE');
    const warnings = await ctx.admin('proctor_warnings').where('attempt_id', A.attemptId);
    expect(warnings.length).toBe(5);
    const alert = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'SUSPENSION_ALERT' });
    expect(alert.length).toBeGreaterThanOrEqual(1);
    // suspended student sees the state, not raw AI data
    const hb = await req().post(`/api/v1/student/attempts/${A.attemptId}/heartbeat`).set(H(A.token)).set('x-device-session', deviceA);
    expect(hb.body.status).toBe('SUSPENDED');
  });

  it('an authorized proctor resumes with a new epoch; history is kept; an ordinary proctor cannot', async () => {
    const proctor = evaluator; // holds PROCTOR but not CHIEF_PROCTOR
    const denied = await req().post(`/api/v1/proctor/attempts/${A.attemptId}/resume`).set(H(proctor.token)).send({ reasonCode: 'REVIEWED', notes: 'invigilator confirms student was helping a neighbour with a cable', idempotencyKey: randomUUID() });
    expect(denied.status).toBe(403);
    const key = randomUUID();
    const res = await req().post(`/api/v1/proctor/attempts/${A.attemptId}/resume`).set(H(chief.token)).send({ reasonCode: 'REVIEWED', notes: 'warnings 3-5 were one disturbance; invigilator statement attached', idempotencyKey: key, deadlineExtensionMinutes: 5 });
    expect(res.status).toBe(200);
    expect(res.body.attemptStatus).toBe('ACTIVE');
    expect(res.body.epoch).toMatchObject({ no: 2, confirmedCount: 0, open: true });
    expect(res.body.lifetimeWarnings).toBe(5);
    const replay = await req().post(`/api/v1/proctor/attempts/${A.attemptId}/resume`).set(H(chief.token)).send({ reasonCode: 'REVIEWED', notes: 'dup', idempotencyKey: key });
    expect(replay.body.decisionId).toBe(res.body.decisionId);
    const q1 = `/api/v1/student/attempts/${A.attemptId}/answers/Q1`;
    const cur = await req().get(q1).set(H(A.token));
    const blocks = [...cur.body.content.blocks, { id: 'b3', kind: 'paragraph', content: 'after resume' }];
    const save = await req().put(q1).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: randomUUID(), baseRevision: cur.body.serverRevision, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b3', kind: 'paragraph', content: 'after resume' }], contentSha256: answerHash(blocks) });
    expect(save.status).toBe(200);
    const timeline = await req().get(`/api/v1/proctor/attempts/${A.attemptId}/timeline`).set(H(chief.token));
    expect(timeline.status).toBe(200);
    expect(timeline.body.epochs.length).toBe(2);
    expect(timeline.body.warnings.length).toBe(5);
    const types = timeline.body.events.map((e: { event_type: string }) => e.event_type);
    for (const expected of ['precheck.started', 'attempt.admitted', 'answer.revision_saved', 'proctor.warning_confirmed', 'attempt.suspended', 'attempt.resumed']) expect(types).toContain(expected);
  });

  it('exports are locked while the exam is live and the Examination Section is alerted', async () => {
    const blocked = await req().get(`/api/v1/exams/${examId}/exports/scripts`).set(H(examCell.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('EXPORT_LOCKED');
    const audit = await ctx.admin('audit_events').where({ tenant_id: t.tenantId, action: 'export.blocked' });
    expect(audit.length).toBe(1);
    const alerts = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'SECURITY_ALERT' });
    expect(alerts.length).toBeGreaterThanOrEqual(2); // exam cell operator + controller
  });

  it('submission seals every acknowledged revision once; retries return the same receipt; late writes are refused', async () => {
    const key = randomUUID();
    const s1 = await req().post(`/api/v1/student/attempts/${A.attemptId}/submit`).set(H(A.token)).send({ idempotencyKey: key });
    expect(s1.status).toBe(200);
    expect(s1.body.manifest.answers.map((a: { questionId: string }) => a.questionId)).toEqual(['Q1', 'Q2']);
    const s2 = await req().post(`/api/v1/student/attempts/${A.attemptId}/submit`).set(H(A.token)).send({ idempotencyKey: key });
    expect(s2.body.receiptId).toBe(s1.body.receiptId);
    const s3 = await req().post(`/api/v1/student/attempts/${A.attemptId}/submit`).set(H(A.token)).send({ idempotencyKey: randomUUID() });
    expect(s3.status).toBe(409);
    const late = await req().put(`/api/v1/student/attempts/${A.attemptId}/answers/Q1`).set(H(A.token)).set('x-device-session', deviceA).send({ clientOperationId: randomUUID(), baseRevision: 3, answerFormat: 'hybrid-v1', ops: [{ op: 'delete-block', blockId: 'b1' }], contentSha256: 'a'.repeat(64) });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('ATTEMPT_NOT_ACTIVE');
    const packet = await ctx.admin('candidate_review_packets').where('attempt_id', A.attemptId).first();
    expect(packet.status).toBe('ATTEMPT_SEALED');
    await runWorkers(ctx);
    expect(erpEvents.some((e) => e.type === 'attempt.submitted' && e.data['studentExternalId'] === A.externalId)).toBe(true);
  });

  it('student B is admitted on the loaner and expires at close with answers sealed; close is the server deadline authority', async () => {
    const g = await req().post(`/api/v1/student/attempts/${B.attemptId}/entry-grants`).set(H(B.token));
    expect(g.status).toBe(201);
    const a = await req().post(`/api/v1/student/attempts/${B.attemptId}/admit`).set(H(B.token)).send({ grantToken: g.body.grantToken });
    expect(a.status).toBe(200);
    const grant = await ctx.admin('admission_grants').where({ attempt_id: B.attemptId }).first();
    expect(grant.exception_id).toBeTruthy(); // the Controller's exception is recorded on the grant
    const close = await req().post(`/api/v1/exams/${examId}/close`).set(H(examCell.token));
    expect(close.status).toBe(200);
    const b = await ctx.admin('exam_attempts').where('id', B.attemptId).first();
    expect(b.status).toBe('EXPIRED');
    expect(b.sealed_at).toBeTruthy();
    const packets = await ctx.admin('candidate_review_packets').where({ tenant_id: t.tenantId, exam_id: examId });
    expect(packets.length).toBe(2);
    // exports allowed again
    const scripts = await req().get(`/api/v1/exams/${examId}/exports/scripts`).set(H(examCell.token));
    expect(scripts.status).toBe(200);
    expect(scripts.body.scripts.length).toBe(2);
  });

  it('forensic checks run after sealing and route candidates to marking without inventing guilt', async () => {
    const n = await runForensicsOnce(ctx.deps);
    expect(n).toBeGreaterThanOrEqual(2); // the pass is deployment-wide; other tenants' sealed packets ride along
    const pA = await ctx.admin('candidate_review_packets').where('attempt_id', A.attemptId).first();
    expect(pA.status).toBe('ACADEMIC_MARKING_READY');
    expect(pA.integrity_state).toBe('PENDING'); // CONCURRENT_SESSION + technical incident still await a human decision
    expect(pA.sealed_submission_verified).toBe(true);
    const checklist = await req().get(`/api/v1/candidates/${A.attemptId}/checklist`).set(H(examCell.token));
    expect(checklist.status).toBe(200);
    expect(checklist.body.publishable).toBe(false);
    // the proctor dismisses the remaining incidents (duplicate device was the student's own tablet, camera was technical)
    const open = await ctx.admin('proctor_incidents').where({ attempt_id: A.attemptId, status: 'PROCTOR_REVIEW' });
    for (const inc of open) {
      const d = await req().post(`/api/v1/proctor/incidents/${inc.id}/decision`).set(H(chief.token)).send({ action: 'DISMISS', reasonCode: 'REVIEWED_NO_VIOLATION', idempotencyKey: randomUUID() });
      expect(d.status).toBe(200);
    }
  });

  it('the examiner records marks with one explanation per question; invalid marks are refused', async () => {
    const bad = await req().post(`/api/v1/candidates/${A.attemptId}/result-versions`).set(H(evaluator.token)).send({ items: [{ questionId: 'Q1', maxMarks: 10, marks: 11, explanation: 'x' }] });
    expect(bad.status).toBe(422);
    const noAnswer = await req().post(`/api/v1/candidates/${A.attemptId}/result-versions`).set(H(evaluator.token)).send({ items: [{ questionId: 'Q9', maxMarks: 10, marks: 5, explanation: 'x' }] });
    expect(noAnswer.body.code).toBe('MARKS_WITHOUT_ANSWER');
    const criteriaMismatch = await req().post(`/api/v1/candidates/${A.attemptId}/result-versions`).set(H(evaluator.token)).send({ items: [{ questionId: 'Q1', maxMarks: 10, marks: 8, explanation: 'x', criteria: [{ code: 'CONCEPT', max: 5, awarded: 5 }, { code: 'EXAMPLE', max: 5, awarded: 2 }] }] });
    expect(criteriaMismatch.body.code).toBe('CRITERIA_SUM_MISMATCH');
    // automatic proposals: Q1's rubric has no key terms (the examiner judges it), Q2's has — a proposal with its basis
    const prop = await req().get(`/api/v1/candidates/${A.attemptId}/rubric-proposals`).set(H(evaluator.token));
    expect(prop.status).toBe(200);
    const pq1 = prop.body.proposals.find((x: { questionId: string }) => x.questionId === 'Q1');
    const pq2 = prop.body.proposals.find((x: { questionId: string }) => x.questionId === 'Q2');
    expect(pq1).toMatchObject({ proposedMarks: null, method: 'EXAMINER' });
    expect(pq2).toMatchObject({ method: 'RUBRIC_TERMS', proposedMarks: expect.any(Number), criteria: [expect.objectContaining({ code: 'EXPL', max: 10 })] });
    expect(prop.body.needsExaminer).toEqual(['Q1']);
    // students never see proposals
    expect((await req().get(`/api/v1/candidates/${A.attemptId}/rubric-proposals`).set(H(A.token))).status).toBe(403);
    const q2Marks = pq2.proposedMarks === 4 ? 4.5 : 4;
    const noReason = await req().post(`/api/v1/candidates/${A.attemptId}/result-versions`).set(H(evaluator.token)).send({ items: [{ questionId: 'Q1', maxMarks: 10, marks: 8, explanation: 'x' }, { questionId: 'Q2', maxMarks: 10, marks: q2Marks, explanation: 'Partial.' }] });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe('OVERRIDE_REASON_REQUIRED');
    const ok = await req()
      .post(`/api/v1/candidates/${A.attemptId}/result-versions`)
      .set(H(evaluator.token))
      .send({
        items: [
          { questionId: 'Q1', maxMarks: 10, marks: 8, explanation: 'Correct definition and a valid alternative example; diagram labels incomplete.', criteria: [{ code: 'CONCEPT', max: 5, awarded: 5 }, { code: 'DIAGRAM', max: 5, awarded: 3 }] },
          { questionId: 'Q2', maxMarks: 10, marks: q2Marks, explanation: 'Partial: states the idea, no justification.', overrideReason: 'Key terms appear but the prevention methods are not explained.' },
        ],
      });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ version: 1, total: 8 + q2Marks, max: 20 });
    const rv = await ctx.admin('result_versions').where({ attempt_id: A.attemptId, version: 1 }).first();
    const stored = rv.items as Array<Record<string, unknown>>;
    expect(stored.find((i) => i['questionId'] === 'Q1')).toMatchObject({ proposedMarks: null, proposalMethod: 'EXAMINER' });
    expect(stored.find((i) => i['questionId'] === 'Q1')).not.toHaveProperty('overrideReason');
    expect(stored.find((i) => i['questionId'] === 'Q2')).toMatchObject({ proposedMarks: pq2.proposedMarks, proposalMethod: 'RUBRIC_TERMS', overrideReason: 'Key terms appear but the prevention methods are not explained.' });
    // exam cell cannot record marks
    expect((await req().post(`/api/v1/candidates/${A.attemptId}/result-versions`).set(H(examCell.token)).send({ items: [{ questionId: 'Q1', maxMarks: 10, marks: 8, explanation: 'x' }] })).status).toBe(403);
    const p = await ctx.admin('candidate_review_packets').where('attempt_id', A.attemptId).first();
    expect(p.status).toBe('EXAM_CELL_REVIEW');
  });

  it('Exam Cell approval binds to the exact result version; a later mark change invalidates it; only the Controller publishes', async () => {
    const stale = await req().post(`/api/v1/candidates/${A.attemptId}/approvals`).set(H(examCell.token)).send({ reviewedResultVersionId: randomUUID(), reason: 'ok', idempotencyKey: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVIEW');
    const p1 = await ctx.admin('candidate_review_packets').where('attempt_id', A.attemptId).first();
    const ap1 = await req().post(`/api/v1/candidates/${A.attemptId}/approvals`).set(H(examCell.token)).send({ reviewedResultVersionId: p1.result_version_id, reason: 'All checks complete', idempotencyKey: randomUUID() });
    expect(ap1.status).toBe(201);
    expect(ap1.body.status).toBe('CANDIDATE_APPROVED');
    // controller cannot publish without approval id; exam cell cannot publish at all
    expect((await req().post(`/api/v1/candidates/${A.attemptId}/authorize-publication`).set(H(examCell.token)).send({ candidateApprovalId: ap1.body.approvalId, idempotencyKey: randomUUID() })).status).toBe(403);
    // moderation changes marks → approval invalidated (spec test 21)
    const v2 = await req().post(`/api/v1/candidates/${A.attemptId}/result-versions`).set(H(evaluator.token)).send({ items: [{ questionId: 'Q1', maxMarks: 10, marks: 9, explanation: 'Moderation: diagram credit raised.' }, { questionId: 'Q2', maxMarks: 10, marks: 4, explanation: 'Unchanged.', overrideReason: 'Key terms appear but the prevention methods are not explained.' }] });
    expect(v2.status).toBe(201);
    expect(v2.body.invalidatedApprovals).toBe(1);
    const p2 = await ctx.admin('candidate_review_packets').where('attempt_id', A.attemptId).first();
    expect(p2.status).toBe('EXAM_CELL_REVIEW');
    const staleCtrl = await req().post(`/api/v1/candidates/${A.attemptId}/authorize-publication`).set(H(controller.token)).send({ candidateApprovalId: ap1.body.approvalId, idempotencyKey: randomUUID() });
    expect(staleCtrl.status).toBe(409);
    const ap2 = await req().post(`/api/v1/candidates/${A.attemptId}/approvals`).set(H(examCell.token)).send({ reviewedResultVersionId: p2.result_version_id, reason: 'Re-reviewed after moderation', idempotencyKey: randomUUID() });
    expect(ap2.status).toBe(201);
    const pubKey = randomUUID();
    const pub = await req().post(`/api/v1/candidates/${A.attemptId}/authorize-publication`).set(H(controller.token)).send({ candidateApprovalId: ap2.body.approvalId, idempotencyKey: pubKey });
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe('PUBLISHED');
    const pubReplay = await req().post(`/api/v1/candidates/${A.attemptId}/authorize-publication`).set(H(controller.token)).send({ candidateApprovalId: ap2.body.approvalId, idempotencyKey: pubKey });
    expect(pubReplay.body.publicationGrantId).toBe(pub.body.publicationGrantId);
  });

  it('publication writes the lifelong ledger, notifies the ERP with a signed event and the student by mail, and the booklet verifies', async () => {
    const ledger = await req().get('/api/v1/student/me/ledger').set(H(A.token));
    expect(ledger.status).toBe(200);
    expect(ledger.body.records.length).toBe(1);
    expect(ledger.body.records[0]).toMatchObject({ exam_type: 'MID_1', semester: 5, academic_year: '2026-27', grade: 'B+', hall_ticket_number: 'CS301-MID1-0001' });
    expect(Number(ledger.body.records[0].marks)).toBe(13);
    expect(ledger.body.semesters[0]).toMatchObject({ semester: 5 });
    expect(Number(ledger.body.semesters[0].percentage)).toBe(65);
    expect(Number(ledger.body.overall.percentage)).toBe(65);
    await runWorkers(ctx);
    const ev = erpEvents.find((e) => e.type === 'result.published' && e.data['studentExternalId'] === A.externalId);
    expect(ev).toBeTruthy();
    expect(ev!.data).toMatchObject({ examCode: 'CS301-MID1', total: 13, max: 20, resultVersion: 2 });
    expect(JSON.stringify(ev!.data)).not.toContain('warning'); // never proctoring data to the ERP
    const mail = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'RESULT_PUBLISHED', to_address: A.email }).first();
    expect(mail).toBeTruthy();
    expect(mail.body_text).not.toContain('13'); // no marks in mail bodies
    const pull = await req().get('/api/v1/integration/v1/results').set('Authorization', `Bearer ${erpKey.apiKey}`).query({ examCode: 'CS301-MID1' });
    expect(pull.status).toBe(200);
    expect(pull.body.results).toEqual([expect.objectContaining({ studentExternalId: A.externalId, provider: 'uos', grade: 'B+' })]);

    const booklet = await req().get(`/api/v1/student/attempts/${A.attemptId}/booklet`).set(H(A.token));
    expect(booklet.status).toBe(200);
    expect(booklet.body.student).toMatchObject({ registerNumber: '22CSE001', hallTicket: 'CS301-MID1-0001' });
    const q1 = booklet.body.questions.find((q: { questionId: string }) => q.questionId === 'Q1');
    expect(q1.marks).toBe(9);
    expect(q1.explanation).toContain('Moderation');
    expect(q1.answer.blocks.length).toBe(3);
    expect(booklet.body.validation.examiner).toBeTruthy();
    expect(booklet.body.validation.controller).toBeTruthy();
    expect(booklet.body.verificationHash).toMatch(/^[a-f0-9]{64}$/);
    // student B cannot read A's booklet
    expect((await req().get(`/api/v1/student/attempts/${A.attemptId}/booklet`).set(H(B.token))).status).toBe(404);
    const verify = await req().get(`/api/v1/student/verify/${A.attemptId}/2`).set('Host', t.host);
    expect(verify.body).toMatchObject({ valid: true, total: 13, max: 20 });
    const superseded = await req().get(`/api/v1/student/verify/${A.attemptId}/1`).set('Host', t.host);
    expect(superseded.body.valid).toBe(false);
  });

  it('a hold notifies the student and the ERP and blocks publication until released', async () => {
    const hold = await req().post(`/api/v1/candidates/${B.attemptId}/holds`).set(H(examCell.token)).send({ status: 'TECHNICAL_REVIEW_REQUIRED', reason: 'Attendance register mismatch for seat 14' });
    expect(hold.status).toBe(200);
    const notice = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'CANDIDATE_HOLD_NOTICE', to_address: B.email }).first();
    expect(notice.body_text).toContain('seat 14');
    const marksWhileHeld = await req().post(`/api/v1/candidates/${B.attemptId}/result-versions`).set(H(evaluator.token)).send({ items: [{ questionId: 'Q1', maxMarks: 10, marks: 0, explanation: 'No answer submitted.' }] });
    expect(marksWhileHeld.status).toBe(409);
    const release = await req().post(`/api/v1/candidates/${B.attemptId}/holds/release`).set(H(examCell.token)).send({ reason: 'Register corrected by invigilator' });
    expect(release.status).toBe(200);
    const marks = await req().post(`/api/v1/candidates/${B.attemptId}/result-versions`).set(H(evaluator.token)).send({ items: [{ questionId: 'Q1', maxMarks: 10, marks: 0, explanation: 'No answer submitted.' }, { questionId: 'Q2', maxMarks: 10, marks: 0, explanation: 'No answer submitted.' }] });
    expect(marks.status).toBe(201);
    const list = await req().get(`/api/v1/exams/${examId}/candidates`).set(H(examCell.token));
    expect(list.body.summary).toMatchObject({ total: 2, published: 1, ready: 1 });
    await runWorkers(ctx);
    expect(erpEvents.some((e) => e.type === 'candidate.held')).toBe(true);
  });
});
