import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, answerHash, cleanScan, type TestContext, type ProvisionedTenant } from './helpers.js';

/**
 * IP tracking and system scans. Every attempt request leaves a durable network
 * observation; the exam's ipPolicy decides whether an address change is only
 * logged, shown to a human, or held to the admitted address. In-exam scans are
 * append-only evidence whose blocking findings become review incidents — never
 * a warning, never an automatic pause.
 */
describe('network observations, ipPolicy and in-exam device scans', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let chief: Awaited<ReturnType<typeof createStaff>>;
  let examId = '';
  const A = { email: '', token: '', attemptId: '', device: '' };
  const B = { email: '', token: '', attemptId: '' };
  const ADMITTED_IP = '10.10.1.20';
  const H = (token: string, ip = ADMITTED_IP) => ({ Host: t.host, Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip, 'User-Agent': 'ExamOS-Test/1.0' });
  const req = () => ctx.request();
  const saveBody = (text: string) => ({ clientOperationId: randomUUID(), baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: text }], contentSha256: answerHash([{ id: 'b1', kind: 'paragraph', content: text }]) });
  const incidents = () => ctx.admin('proctor_incidents').where({ attempt_id: A.attemptId }).orderBy('first_event_at');
  const dualDisplay = () => cleanScan({ screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, isExtended: true, displayCount: 2 } });

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'net');
    [examCell, chief] = await Promise.all([createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell'), createStaff(ctx, t, ['CHIEF_PROCTOR'], 'chief')]);
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'CSE' }] });
    await K('courses').send({ rows: [{ code: 'CS301', name: 'Networks', departmentCode: 'CSE' }] });
    A.email = `a@${t.slug}.test`;
    B.email = `b@${t.slug}.test`;
    await K('persons').send({ rows: [{ externalId: 'UOS-7001', kind: 'STUDENT', fullName: 'Net Student A', email: A.email }, { externalId: 'UOS-7002', kind: 'STUDENT', fullName: 'Net Student B', email: B.email }] });
    await K('enrollments').send({ rows: [{ studentExternalId: 'UOS-7001', courseCode: 'CS301', academicYear: '2026-27', term: 'ODD' }, { studentExternalId: 'UOS-7002', courseCode: 'CS301', academicYear: '2026-27', term: 'ODD' }] });
    for (const s of [A, B]) {
      const token = await activationTokenFor(ctx, t.tenantId, s.email);
      await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password: 'Student-Passw0rd!2026' });
      const login = await req().post('/api/v1/auth/login').set('Host', t.host).set('User-Agent', 'ExamOS-Test/1.0').send({ email: s.email, password: 'Student-Passw0rd!2026' });
      expect(login.status).toBe(200);
      s.token = login.body.accessToken;
    }

    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'CS301-MID', title: 'Networks — Mid 1', courseCode: 'CS301', examType: 'MID_1', academicYear: '2026-27', semester: 5, securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 4 * 3600_000).toISOString() });
    expect(create.status).toBe(201);
    examId = create.body.examId;
    await req().put(`/api/v1/exams/${examId}/paper`).set(H(examCell.token)).send({ title: 'Networks paper', sections: [{ code: 'A', title: 'Main' }], questions: [{ questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Explain TCP slow start.' }] }, maxMarks: 10, attachments: [] }] });
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: ['UOS-7001', 'UOS-7002'], provider: 'uos' });
    for (const step of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token));
    A.attemptId = (await req().get('/api/v1/student/me/exams').set(H(A.token))).body.exams[0].attemptId;
    B.attemptId = (await req().get('/api/v1/student/me/exams').set(H(B.token))).body.exams[0].attemptId;
  });
  afterAll(async () => ctx.close());

  it('login sessions remember their address and user agent', async () => {
    const user = await ctx.admin('users').where({ email: A.email }).first('id');
    const session = await ctx.admin('auth_sessions').where({ user_id: user.id }).orderBy('issued_at', 'desc').first();
    expect(session.ip).toBe('127.0.0.1');
    expect(session.user_agent).toBe('ExamOS-Test/1.0');
  });

  it('readiness, admission and every in-exam request leave a network observation; under LOG a change is only an event', async () => {
    const start = await req().post(`/api/v1/student/attempts/${A.attemptId}/prechecks`).set(H(A.token)).send({ clientBuild: 'chrome-130' });
    expect(start.status).toBe(201);
    const runId = start.body.runId as string;
    const v = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(A.token)).send(body);
    await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Congestion windows grow: 1, 2, 4, 8 (then linear)!' });
    await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(A.token)).send({ contentDigest: 'a'.repeat(64) });
    await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    const fin = await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(A.token));
    expect(fin.body.status).toBe('READY');

    await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));
    const g = await req().post(`/api/v1/student/attempts/${A.attemptId}/entry-grants`).set(H(A.token));
    const admitted = await req().post(`/api/v1/student/attempts/${A.attemptId}/admit`).set(H(A.token)).send({ grantToken: g.body.grantToken });
    expect(admitted.status).toBe(200);
    A.device = admitted.body.deviceSessionId;
    const row = await ctx.admin('exam_attempts').where('id', A.attemptId).first();
    expect(row.admitted_ip).toBe(ADMITTED_IP);
    expect(row.admitted_user_agent).toBeTruthy();

    expect((await req().post(`/api/v1/student/attempts/${A.attemptId}/heartbeat`).set(H(A.token)).set('x-device-session', A.device)).status).toBe(200);
    expect((await req().put(`/api/v1/student/attempts/${A.attemptId}/answers/Q1`).set(H(A.token)).set('x-device-session', A.device).send(saveBody('slow start doubles'))).status).toBe(200);
    // Wi-Fi → hotspot: a different address, same device. LOG policy: context only.
    const moved = await req().post(`/api/v1/student/attempts/${A.attemptId}/heartbeat`).set(H(A.token, '10.10.9.9')).set('x-device-session', A.device);
    expect(moved.status).toBe(200);

    const seen = await ctx.admin('attempt_network_observations').where({ attempt_id: A.attemptId }).orderBy('first_seen_at');
    expect(seen.map((s) => s.ip)).toEqual([ADMITTED_IP, '10.10.9.9']);
    expect(seen[0].first_source).toBe('PRECHECK');
    expect(Number(seen[0].observations)).toBeGreaterThanOrEqual(1); // touches are recorded at most once a minute per address
    expect(seen[1].first_source).toBe('HEARTBEAT');
    const events = (await ctx.admin('attempt_event_log').where({ attempt_id: A.attemptId }).select('event_type', 'metadata')).filter((e) => e.event_type === 'network.address_changed');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ from: ADMITTED_IP, to: '10.10.9.9', policy: 'LOG' });
    expect(await incidents()).toHaveLength(0);
  });

  it('REVIEW policy raises NETWORK_ADDRESS_CHANGED for a human; the write succeeds and nothing counts', async () => {
    const upd = await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ ipPolicy: 'REVIEW' });
    expect(upd.status).toBe(200);
    expect(upd.body.policy.ipPolicy).toBe('REVIEW');
    const doc = await ctx.admin('answer_documents').where({ attempt_id: A.attemptId, question_id: 'Q1' }).first('current_revision');
    const save = await req().put(`/api/v1/student/attempts/${A.attemptId}/answers/Q1`).set(H(A.token, '10.10.77.1')).set('x-device-session', A.device).send({ ...saveBody('slow start doubles each RTT'), baseRevision: doc.current_revision });
    expect(save.status).toBe(200);
    const inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ signal_class: 'NETWORK_ADDRESS_CHANGED', status: 'PROCTOR_REVIEW' });
    expect(await ctx.admin('proctor_warnings').where({ attempt_id: A.attemptId })).toHaveLength(0);
    expect((await ctx.admin('exam_attempts').where('id', A.attemptId).first('status')).status).toBe('ACTIVE');
  });

  it('LOCK policy holds writes to the admitted address, records the refusal, and a proctor resume re-binds the network', async () => {
    await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ ipPolicy: 'LOCK' });
    const rev = async () => (await ctx.admin('answer_documents').where({ attempt_id: A.attemptId, question_id: 'Q1' }).first('current_revision')).current_revision as number;
    const r0 = await rev();
    const ok = await req().put(`/api/v1/student/attempts/${A.attemptId}/answers/Q1`).set(H(A.token)).set('x-device-session', A.device).send({ ...saveBody('from the admitted network'), baseRevision: r0 });
    expect(ok.status).toBe(200);

    const refused = await req().put(`/api/v1/student/attempts/${A.attemptId}/answers/Q1`).set(H(A.token, '10.10.88.8')).set('x-device-session', A.device).send({ ...saveBody('from elsewhere'), baseRevision: r0 + 1 });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NETWORK_ADDRESS_LOCKED');
    expect(await rev()).toBe(r0 + 1);
    // record, then refuse: the evidence survived the rolled-back write
    const obs = await ctx.admin('attempt_network_observations').where({ attempt_id: A.attemptId, ip: '10.10.88.8' }).first();
    expect(obs).toBeTruthy();
    expect(obs.first_source).toBe('SAVE');
    const refusals = (await ctx.admin('attempt_event_log').where({ attempt_id: A.attemptId }).select('event_type')).filter((e) => e.event_type === 'network.refused_address_locked');
    expect(refusals).toHaveLength(1);
    // the second address change within the grouping window joins the open review incident rather than opening another
    const netInc = (await incidents()).filter((i) => i.signal_class === 'NETWORK_ADDRESS_CHANGED');
    expect(netInc).toHaveLength(1);
    expect(netInc[0].event_count).toBe(2);
    expect(await ctx.admin('proctor_warnings').where({ attempt_id: A.attemptId })).toHaveLength(0);
    // heartbeats from the locked address are refused the same way; the attempt itself is untouched
    expect((await req().post(`/api/v1/student/attempts/${A.attemptId}/heartbeat`).set(H(A.token, '10.10.88.8')).set('x-device-session', A.device)).status).toBe(409);
    expect((await ctx.admin('exam_attempts').where('id', A.attemptId).first('status')).status).toBe('ACTIVE');

    // the invigilator moves the student (room change): technical hold, resume with rebind, reconnect from the new network
    const hold = await req().post(`/api/v1/proctor/attempts/${A.attemptId}/technical-holds`).set(H(chief.token)).send({ reasonCode: 'ROOM_CHANGE', notes: 'moved to lab 2 with the invigilator', idempotencyKey: randomUUID() });
    expect(hold.status).toBe(200);
    const resume = await req().post(`/api/v1/proctor/attempts/${A.attemptId}/resume`).set(H(chief.token)).send({ reasonCode: 'ROOM_CHANGE', notes: 'continue in lab 2', idempotencyKey: randomUUID(), deadlineExtensionMinutes: 0, rebindDevice: true });
    expect(resume.status).toBe(200);
    expect((await ctx.admin('exam_attempts').where('id', A.attemptId).first('admitted_ip')).admitted_ip).toBeNull();
    const back = await req().post(`/api/v1/student/attempts/${A.attemptId}/reconnect`).set(H(A.token, '10.10.88.8')).set('x-device-session', A.device);
    expect(back.status).toBe(200);
    expect((await ctx.admin('exam_attempts').where('id', A.attemptId).first('admitted_ip')).admitted_ip).toBe('10.10.88.8');
    const r1 = await rev();
    expect((await req().put(`/api/v1/student/attempts/${A.attemptId}/answers/Q1`).set(H(A.token, '10.10.88.8')).set('x-device-session', A.device).send({ ...saveBody('continuing in lab 2'), baseRevision: r1 })).status).toBe(200);
    expect((await req().put(`/api/v1/student/attempts/${A.attemptId}/answers/Q1`).set(H(A.token)).set('x-device-session', A.device).send({ ...saveBody('old network'), baseRevision: r1 + 1 })).status).toBe(409);
  });

  it('in-exam system scans are evidence; a blocking finding is a review incident, never a warning or a pause', async () => {
    const ip = '10.10.88.8';
    const clean = await req().post(`/api/v1/student/attempts/${A.attemptId}/device-scans`).set(H(A.token, ip)).set('x-device-session', A.device).send({ scan: cleanScan() });
    expect(clean.status).toBe(202);
    expect(clean.body).toMatchObject({ verdict: 'CLEAN', findings: [] });
    const before = (await incidents()).length;

    const dual = await req().post(`/api/v1/student/attempts/${A.attemptId}/device-scans`).set(H(A.token, ip)).send({ scan: dualDisplay() });
    expect(dual.status).toBe(202);
    expect(dual.body).toMatchObject({ verdict: 'BLOCKED', findings: ['MULTIPLE_DISPLAYS'] });
    const again = await req().post(`/api/v1/student/attempts/${A.attemptId}/device-scans`).set(H(A.token, ip)).send({ scan: dualDisplay() });
    expect(again.status).toBe(202);
    const bot = await req().post(`/api/v1/student/attempts/${A.attemptId}/device-scans`).set(H(A.token, ip)).send({ scan: cleanScan({ browser: { webdriver: true, cookiesEnabled: true, fullscreenSupported: true, pdfViewer: true, pluginsCount: 0, displayCaptureActive: false, devtoolsHeuristic: false } }) });
    expect(bot.body.findings).toEqual(['AUTOMATION_CONTROLLED']);

    const inc = await incidents();
    const dualInc = inc.filter((i) => i.signal_class === 'DUAL_SCREEN_DETECTED');
    expect(dualInc).toHaveLength(1); // two scans within the grouping window → one incident with two events
    expect(dualInc[0].status).toBe('PROCTOR_REVIEW');
    expect(dualInc[0].event_count).toBe(2);
    expect(inc.filter((i) => i.signal_class === 'AUTOMATION_DETECTED')).toHaveLength(1);
    expect(inc.length).toBe(before + 2);
    expect(await ctx.admin('proctor_warnings').where({ attempt_id: A.attemptId })).toHaveLength(0);
    expect((await ctx.admin('exam_attempts').where('id', A.attemptId).first('status')).status).toBe('ACTIVE');
    const scans = await ctx.admin('device_scans').where({ attempt_id: A.attemptId, phase: 'IN_EXAM' }).orderBy('created_at');
    expect(scans.map((s) => s.verdict)).toEqual(['CLEAN', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    expect(scans.every((s) => s.ip === ip && s.scan_sha256.length === 64)).toBe(true);

    // a scan is only accepted for the student's own, open attempt
    expect((await req().post(`/api/v1/student/attempts/${A.attemptId}/device-scans`).set(H(B.token)).send({ scan: cleanScan() })).status).toBe(404);
    const notOpen = await req().post(`/api/v1/student/attempts/${B.attemptId}/device-scans`).set(H(B.token)).send({ scan: cleanScan() });
    expect(notOpen.status).toBe(409);
    expect(notOpen.body.code).toBe('ATTEMPT_STATE');
    // the client never gets to declare a verdict
    expect((await req().post(`/api/v1/student/attempts/${A.attemptId}/device-scans`).set(H(A.token, ip)).send({ scan: { verdict: 'CLEAN' } })).status).toBe(400);
  });

  it('the timeline shows every address and scan to the human who decides', async () => {
    const tl = await req().get(`/api/v1/proctor/attempts/${A.attemptId}/timeline`).set(H(chief.token));
    expect(tl.status).toBe(200);
    expect(tl.body.network.map((n: { ip: string }) => n.ip)).toEqual([ADMITTED_IP, '10.10.9.9', '10.10.77.1', '10.10.88.8']);
    expect(tl.body.deviceScans.length).toBeGreaterThanOrEqual(5);
    expect(tl.body.deviceScans[0]).toMatchObject({ phase: 'PRECHECK', verdict: 'CLEAN' });
    expect(tl.body.deviceScans.some((d: { verdict: string; findings: string[] }) => d.verdict === 'BLOCKED' && d.findings.includes('MULTIPLE_DISPLAYS'))).toBe(true);
    expect(JSON.stringify(tl.body)).not.toContain('"scan":'); // raw scans stay in the evidence table; the console gets findings
  });

  it('browser lockdown signals reach the proctor with their context; server-only classes and oversized metadata are refused', async () => {
    const ev = (signalClass: string, metadata: Record<string, unknown>) => ({ sourceEventId: randomUUID(), attemptId: A.attemptId, signalClass, clientRecordedAt: new Date().toISOString(), clientSequence: 1, metadata });
    const post = (events: unknown[], token = A.token) => req().post('/api/v1/proctor/events').set(H(token, '10.10.88.8')).send({ events });
    const episode = randomUUID();
    const ok = await post([
      ev('FOCUS_LOST', { phase: 'left', reason: 'tab-hidden', episode }),
      ev('FOCUS_LOST', { phase: 'returned', reason: 'tab-hidden', awayMs: 42_000, episode }),
      ev('DISPLAY_CHANGED', { from: { width: 1920, height: 1080 }, to: { width: 1024, height: 768 } }),
      ev('MULTIPLE_TABS', { tabs: 2 }),
      ev('CLIPBOARD_ATTEMPT', { kind: 'external-paste' }),
    ]);
    expect(ok.status).toBe(202);
    expect(ok.body.results.every((r: { accepted: boolean }) => r.accepted)).toBe(true);
    const inc = await incidents();
    const focus = inc.filter((i) => i.signal_class === 'FOCUS_LOST');
    expect(focus).toHaveLength(1); // leave + return of one episode are one incident
    expect(focus[0]).toMatchObject({ status: 'PROCTOR_REVIEW', event_count: 2 });
    for (const c of ['DISPLAY_CHANGED', 'MULTIPLE_TABS', 'CLIPBOARD_ATTEMPT']) expect(inc.find((i) => i.signal_class === c)?.status).toBe('PROCTOR_REVIEW');

    // a client may never report what only the server observes
    for (const c of ['CONCURRENT_SESSION', 'NETWORK_ADDRESS_CHANGED', 'SECURE_CLIENT_MISSING']) {
      const forged = await post([ev(c, {})]);
      expect(forged.status).toBe(403);
      expect(forged.body.code).toBe('SERVER_ONLY_SIGNAL');
    }
    expect((await incidents()).filter((i) => i.signal_class === 'CONCURRENT_SESSION')).toHaveLength(0);
    // metadata is bounded context, not a payload carrier; and a student reports only for their own attempt
    expect((await post([ev('FOCUS_LOST', { blob: 'x'.repeat(3000) })])).status).toBe(400);
    expect((await post([ev('FOCUS_LOST', {})], B.token)).status).toBe(403);

    // the proctor sees each raw signal with its context and the server's receipt time
    const tl = await req().get(`/api/v1/proctor/attempts/${A.attemptId}/timeline`).set(H(chief.token));
    const returned = tl.body.signals.find((s: { metadata: { phase?: string } }) => s.metadata.phase === 'returned');
    expect(returned).toMatchObject({ signal_class: 'FOCUS_LOST', incident_id: focus[0].id, source_id: expect.stringMatching(/^CLIENT:/), metadata: { awayMs: 42_000, reason: 'tab-hidden' } });
    expect(typeof returned.server_received_at).toBe('string');
    expect(await ctx.admin('proctor_warnings').where({ attempt_id: A.attemptId })).toHaveLength(0);
  });
});
