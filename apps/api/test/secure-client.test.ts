import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, type TestContext, type ProvisionedTenant } from './helpers.js';
import { sha256Hex } from '../src/lib/crypto.js';

describe('Phase 4 — Secure Client, SEB Configuration, and Cheating Mitigation', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();

  let courseId: string;
  let student1: { userId: string; email: string; token: string; registerNumber: string };
  let student2: { userId: string; email: string; token: string; registerNumber: string };
  let examCell: { userId: string; email: string; token: string };
  let proctor: { userId: string; email: string; token: string };

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'smru-secure-client');

    const courseRes = await ctx.admin('courses').insert({
      id: randomUUID(),
      tenant_id: t.tenantId,
      code: 'CS401',
      name: 'Computer Networks & Security',
    }).returning('id');
    courseId = courseRes[0]!.id;

    // Helper to register users
    async function createUser(email: string, fullName: string, kind: 'STUDENT' | 'STAFF', roles: Array<{ role: string; scopeType?: string; scopeId?: string | null }>) {
      const uRes = await req()
        .post('/api/v1/tenant/users')
        .set(H(t.admin.token))
        .send({
          email,
          fullName,
          kind,
          roles: roles.map((r) => ({
            role: r.role,
            scopeType: r.scopeType ?? 'TENANT',
            ...(r.scopeId ? { scopeId: r.scopeId } : {}),
          })),
        });
      expect(uRes.status).toBe(201);
      const userId = uRes.body.userId as string;

      // Activate user
      const mailRow = await ctx.admin('mail_dispatches')
        .where({ tenant_id: t.tenantId, category: 'ACCOUNT_ACTIVATION', to_address: email })
        .orderBy('created_at', 'desc')
        .first();
      const m = /token=([^\s]+)/.exec(mailRow.body_text);
      const actRes = await req().post('/api/v1/auth/activate').set('Host', t.host).send({
        token: decodeURIComponent(m![1]!),
        password: 'Password!2026',
      });
      expect(actRes.status).toBe(200);

      return { userId, email, token: actRes.body.accessToken as string };
    }

    const s1 = await createUser('student.secure1@demo.local', 'Aditya Verma', 'STUDENT', [{ role: 'STUDENT', scopeType: 'TENANT' }]);
    student1 = { ...s1, registerNumber: '2026-CS-0101' };

    const s2 = await createUser('student.secure2@demo.local', 'Divya Patel', 'STUDENT', [{ role: 'STUDENT', scopeType: 'TENANT' }]);
    student2 = { ...s2, registerNumber: '2026-CS-0102' };

    examCell = await createUser('examcell.sec@demo.local', 'Exam Cell Operator', 'STAFF', [{ role: 'EXAM_CELL_OPERATOR', scopeType: 'TENANT' }]);
    proctor = await createUser('proctor.sec@demo.local', 'Lead Invigilator', 'STAFF', [{ role: 'PROCTOR', scopeType: 'TENANT' }]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function allocateStudent(examId: string, studentId: string, status: string = 'PRECHECK_AVAILABLE') {
    const attemptId = randomUUID();
    await ctx.admin('exam_allocations').insert({
      id: randomUUID(),
      tenant_id: t.tenantId,
      exam_id: examId,
      user_id: studentId,
      status: 'ALLOCATED',
    });
    await ctx.admin('exam_attempts').insert({
      id: attemptId,
      tenant_id: t.tenantId,
      exam_id: examId,
      user_id: studentId,
      status,
      attempt_no: 1,
    });
    return attemptId;
  }

  it('generates SEB XML configuration with kiosk mode and enforces download authorization', async () => {
    const now = Date.now();
    const createExam = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({
        code: 'CS401-MID',
        title: 'Networks Mid-term',
        courseCode: 'CS401',
        examType: 'MID_1',
        securityProfile: 'SECURE_BYOD',
        durationMinutes: 90,
        windowStartAt: new Date(now - 60_000).toISOString(),
        windowEndAt: new Date(now + 3 * 3600_000).toISOString(),
        policy: {},
      });
    expect(createExam.status).toBe(201);
    const examId = createExam.body.examId as string;

    // Allocate student1 only
    await allocateStudent(examId, student1.userId);

    // 1. Generate SEB configuration via POST /exams/:id/seb-config
    const genRes = await req()
      .post(`/api/v1/exams/${examId}/seb-config`)
      .set(H(examCell.token))
      .send({
        allowQuit: true,
        kioskMode: true,
        blockVirtualMachines: true,
        blockScreenCapture: true,
        blockClipboard: true,
        quitPassword: 'invigilator-2026',
        prohibitedProcesses: ['LockDownHelper.exe', 'com.example.cheatsheet', 'Discord.exe'],
      });
    expect(genRes.status).toBe(201);
    expect(genRes.body.sebConfigKey).toMatch(/^[a-f0-9]{64}$/);
    const sebConfigKey = genRes.body.sebConfigKey as string;

    // 2. Staff download of .seb file
    const staffDownload = await req()
      .get(`/api/v1/exams/${examId}/seb-config`)
      .set(H(examCell.token));
    expect(staffDownload.status).toBe(200);
    expect(staffDownload.headers['content-type']).toBe('application/seb');
    expect(staffDownload.headers['x-seb-configkey']).toBe(sebConfigKey);
    const xml = staffDownload.text;
    expect(xml).toContain('<!DOCTYPE plist');
    const settings = parsePlist(xml) as Record<string, unknown>;
    // SEB's Config Key, recomputed independently from the file the student opens, is the key the server verifies
    expect(sebKeyOf(settings)).toBe(sebConfigKey);
    expect(settings['startURL']).toBe(`http://${t.host}/student`);
    expect(settings['URLFilterEnable']).toBe(true);
    expect(settings['URLFilterRules']).toEqual([{ action: 1, active: true, expression: t.host, regex: false }, { action: 1, active: true, expression: `${t.host}/*`, regex: false }]);
    expect(settings).toMatchObject({ createNewDesktop: true, killExplorerShell: true, enableAltTab: false, allowedDisplaysMaxNumber: 1, allowDisplayMirroring: false, allowScreenSharing: false, allowVirtualMachine: false, enablePrintScreen: false, enablePrivateClipboard: true, sendBrowserExamKey: true });
    expect(settings['hashedQuitPassword']).toBe(sha256Hex('invigilator-2026'));
    expect(xml).not.toContain('invigilator-2026');
    // every listed app is force-quit (strongKill) on both platforms; the Examination Section's entries are added once
    const procs = settings['prohibitedProcesses'] as Array<Record<string, unknown>>;
    expect(procs.every((p) => p['strongKill'] === true && p['active'] === true)).toBe(true);
    const has = (os: number, exe: string) => procs.some((p) => p['os'] === os && String(p['executable']).toLowerCase() === exe.toLowerCase());
    for (const exe of ['Teams.exe', 'Zoom.exe', 'AnyDesk.exe', 'TeamViewer.exe', 'obs64.exe', 'ChatGPT.exe', 'LockDownHelper.exe']) expect(has(1, exe)).toBe(true);
    expect(procs.some((p) => p['os'] === 0 && p['identifier'] === 'us.zoom.xos')).toBe(true);
    expect(procs.some((p) => p['os'] === 0 && p['identifier'] === 'com.example.cheatsheet')).toBe(true);
    expect(procs.filter((p) => p['os'] === 1 && String(p['executable']).toLowerCase() === 'discord.exe')).toHaveLength(1);
    expect(genRes.body.prohibitedApps).toBe(procs.length);

    // 3. Student1 (allocated) downloads .seb file
    const studentDownload = await req()
      .get(`/api/v1/student/me/exams/${examId}/seb-config`)
      .set(H(student1.token));
    expect(studentDownload.status).toBe(200);
    expect(studentDownload.headers['content-type']).toBe('application/seb');
    expect(studentDownload.headers['x-seb-configkey']).toBe(sebConfigKey);

    // 4. Student2 (NOT allocated) is refused with 403 NOT_ALLOCATED
    const refusedDownload = await req()
      .get(`/api/v1/student/me/exams/${examId}/seb-config`)
      .set(H(student2.token));
    expect(refusedDownload.status).toBe(403);
    expect(refusedDownload.body.code).toBe('NOT_ALLOCATED');

    // 5. Verify audit rows created
    const audits = await ctx.admin('audit_events')
      .where({ tenant_id: t.tenantId, entity_id: examId })
      .select('action');
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('seb_config.generated');
    expect(actions).toContain('seb_config.downloaded');

    // once the exam is live the configuration and keys are frozen: changing them would lock every student out
    await ctx.admin('exams').where({ id: examId }).update({ status: 'LIVE' });
    const frozen = await req().post(`/api/v1/exams/${examId}/seb-config`).set(H(examCell.token)).send({});
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('SEB_CONFIG_FROZEN');
    const frozenKey = await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ sebConfigKey: 'a'.repeat(64) });
    expect(frozenKey.status).toBe(409);
    // SEB only applies to SECURE_BYOD exams
    const basic = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'CS401-QUIZ', title: 'Quiz', courseCode: 'CS401', examType: 'MID_1', securityProfile: 'BASIC_BROWSER', durationMinutes: 30, windowStartAt: new Date(now - 60_000).toISOString(), windowEndAt: new Date(now + 3600_000).toISOString() });
    expect((await req().post(`/api/v1/exams/${basic.body.examId}/seb-config`).set(H(examCell.token)).send({})).body.code).toBe('SEB_NOT_APPLICABLE');
  });

  it('validates SEB Config Key cryptographic handshake in precheck and rejects tampering', async () => {
    const now = Date.now();
    const SEB_KEY = 'e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2';

    const createExam = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({
        code: 'CS402-FINAL',
        title: 'Distributed Systems',
        courseCode: 'CS401',
        examType: 'SEM_INTERNAL',
        securityProfile: 'SECURE_BYOD',
        durationMinutes: 120,
        windowStartAt: new Date(now - 60_000).toISOString(),
        windowEndAt: new Date(now + 4 * 3600_000).toISOString(),
        policy: { sebConfigKey: SEB_KEY },
      });
    expect(createExam.status).toBe(201);
    const examId = createExam.body.examId as string;

    // Allocate student
    const attemptId = await allocateStudent(examId, student1.userId, 'PRECHECK_AVAILABLE');

    // Move exam through conduct to PRECHECK
    await ctx.admin('exams').where({ id: examId }).update({ status: 'PRECHECK' });

    // Start precheck
    const startPrecheck = await req()
      .post(`/api/v1/student/attempts/${attemptId}/prechecks`)
      .set(H(student1.token))
      .send({ clientBuild: 'SEB_Mac_3.3.2' });
    expect(startPrecheck.status).toBe(201);
    const runId = startPrecheck.body.runId as string;

    const verifyPath = `/api/v1/student/prechecks/${runId}/items/verify`;
    const fullUrl = `http://${t.host}${verifyPath}`;

    // 1. Plain request with NO header -> REMEDIATE / SEB_REQUIRED
    const plainRes = await req()
      .post(verifyPath)
      .set(H(student1.token))
      .send({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Mac_3.3.2' });
    const plainCheck = plainRes.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION');
    expect(plainCheck).toMatchObject({
      status: 'REMEDIATE',
      diagnosticCode: 'SEB_REQUIRED',
      source: 'SERVER',
    });

    // 2. Tampered header hash -> REMEDIATE / SEB_CONFIG_KEY_MISMATCH
    const forgedRes = await req()
      .post(verifyPath)
      .set(H(student1.token))
      .set('X-SafeExamBrowser-ConfigKeyHash', '00'.repeat(32))
      .send({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Mac_3.3.2' });
    const forgedCheck = forgedRes.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION');
    expect(forgedCheck).toMatchObject({
      status: 'REMEDIATE',
      diagnosticCode: 'SEB_CONFIG_KEY_MISMATCH',
    });

    // 3. Genuine SEB hash: SHA256(requestUrl + SEB_KEY) -> PASS / SECURE_CLIENT
    const genuineHash = sha256Hex(`${fullUrl}${SEB_KEY}`);
    const genuineRes = await req()
      .post(verifyPath)
      .set(H(student1.token))
      .set('X-SafeExamBrowser-ConfigKeyHash', genuineHash)
      .send({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Mac_3.3.2' });
    const genuineCheck = genuineRes.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION');
    expect(genuineCheck).toMatchObject({
      status: 'PASS',
      source: 'SECURE_CLIENT',
      diagnosticCode: null,
    });

    // 4. SEB for macOS/iOS: the JavaScript API gives hashes for the PAGE url; the page url must be this exam site
    const pageUrl = `http://${t.host}/student/attempts/${attemptId}/readiness`;
    const js = (headers: Record<string, string>) => req().post(verifyPath).set(H(student1.token)).set(headers).send({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Mac_3.3.2' });
    const jsCheck = async (headers: Record<string, string>) => (await js(headers)).body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION');
    expect(await jsCheck({ 'X-SEB-Page-Url': pageUrl, 'X-SEB-Config-Key-Hash': sha256Hex(`${pageUrl}${SEB_KEY}`) })).toMatchObject({ status: 'PASS', source: 'SECURE_CLIENT' });
    const foreign = 'https://evil.example/student';
    expect(await jsCheck({ 'X-SEB-Page-Url': foreign, 'X-SEB-Config-Key-Hash': sha256Hex(`${foreign}${SEB_KEY}`) })).toMatchObject({ status: 'REMEDIATE' });

    // 5. Registered Browser Exam Keys (per approved SEB build): the config key alone is no longer enough
    const BEK = 'b'.repeat(64);
    expect((await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ sebBrowserExamKeys: [BEK.toUpperCase()] })).status).toBe(200);
    expect((await req().post(verifyPath).set(H(student1.token)).set('X-SafeExamBrowser-ConfigKeyHash', genuineHash).send({ code: 'CLIENT_VERSION' })).body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION')).toMatchObject({ status: 'REMEDIATE', diagnosticCode: 'SEB_CONFIG_KEY_MISMATCH' });
    const withBek = await req().post(verifyPath).set(H(student1.token)).set('X-SafeExamBrowser-ConfigKeyHash', genuineHash).set('X-SafeExamBrowser-RequestHash', sha256Hex(`${fullUrl}${BEK}`)).send({ code: 'CLIENT_VERSION' });
    expect(withBek.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION')).toMatchObject({ status: 'PASS', source: 'SECURE_CLIENT' });
  });

  it('enforces MANAGED_ENDPOINT subnet attestation and client policy updates', async () => {
    const now = Date.now();
    const createExam = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({
        code: 'CS403-LAB',
        title: 'Network Lab Exam',
        courseCode: 'CS401',
        examType: 'PRACTICAL',
        securityProfile: 'MANAGED_ENDPOINT',
        durationMinutes: 60,
        windowStartAt: new Date(now - 60_000).toISOString(),
        windowEndAt: new Date(now + 2 * 3600_000).toISOString(),
        policy: {
          requireManagedEndpoint: true,
          allowedSubnets: ['10.100.0.0/16', '192.168.50.0/24'],
        },
      });
    expect(createExam.status).toBe(201);
    const examId = createExam.body.examId as string;

    // 1. Update policy via PUT /exams/:id/client-policy
    const updateRes = await req()
      .put(`/api/v1/exams/${examId}/client-policy`)
      .set(H(examCell.token))
      .send({
        allowedSubnets: ['10.100.0.0/16', '172.20.0.0/16'],
        requireManagedEndpoint: true,
        allowedClientBuilds: ['SEB_Win_3.8.0', 'SMRU_Lab_Kiosk_1.2'],
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.policy.allowedSubnets).toEqual(['10.100.0.0/16', '172.20.0.0/16']);

    // 2. Allocate and move to PRECHECK
    const attemptId = await allocateStudent(examId, student1.userId, 'PRECHECK_AVAILABLE');
    await ctx.admin('exams').where({ id: examId }).update({ status: 'PRECHECK' });

    const startPrecheck = await req()
      .post(`/api/v1/student/attempts/${attemptId}/prechecks`)
      .set(H(student1.token))
      .send({ clientBuild: 'SMRU_Lab_Kiosk_1.2' });
    const runId = startPrecheck.body.runId as string;

    // 3. Verify from unauthorized IP (outside subnet) -> REMEDIATE / MANAGED_ENDPOINT_REQUIRED
    const unauthorizedRes = await req()
      .post(`/api/v1/student/prechecks/${runId}/items/verify`)
      .set(H(student1.token))
      .set('X-Forwarded-For', '203.0.113.88')
      .send({ code: 'CLIENT_VERSION', clientBuild: 'SMRU_Lab_Kiosk_1.2' });
    const unauthCheck = unauthorizedRes.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION');
    expect(unauthCheck).toMatchObject({
      status: 'REMEDIATE',
      diagnosticCode: 'MANAGED_ENDPOINT_REQUIRED',
    });

    // 4. Verify from authorized lab IP (within 10.100.0.0/16) -> PASS / SECURE_CLIENT
    const authorizedRes = await req()
      .post(`/api/v1/student/prechecks/${runId}/items/verify`)
      .set(H(student1.token))
      .set('X-Forwarded-For', '10.100.42.15')
      .send({ code: 'CLIENT_VERSION', clientBuild: 'SMRU_Lab_Kiosk_1.2' });
    const authCheck = authorizedRes.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION');
    expect(authCheck).toMatchObject({
      status: 'PASS',
      source: 'SECURE_CLIENT',
    });
  });

  it('ingests client-side cheating signals (DISALLOWED_APP, VIRTUAL_MACHINE) without auto-counting', async () => {
    const now = Date.now();
    const createExam = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({
        code: 'CS404-LIVE',
        title: 'Real-Time Networks',
        courseCode: 'CS401',
        examType: 'SEM_EXTERNAL',
        securityProfile: 'SECURE_BYOD',
        durationMinutes: 90,
        windowStartAt: new Date(now - 60_000).toISOString(),
        windowEndAt: new Date(now + 2 * 3600_000).toISOString(),
        policy: {},
      });
    const examId = createExam.body.examId as string;

    const attemptId = await allocateStudent(examId, student1.userId, 'ACTIVE');
    await ctx.admin('exams').where({ id: examId }).update({ status: 'LIVE' });

    // Student reports client-detected prohibited apps and VM
    const signalRes = await req()
      .post('/api/v1/proctor/events')
      .set(H(student1.token))
      .send({
        events: [
          {
            sourceEventId: randomUUID(),
            attemptId,
            signalClass: 'DISALLOWED_APP_DETECTED',
            metadata: { process: 'discord.exe', pid: 1420 },
          },
          {
            sourceEventId: randomUUID(),
            attemptId,
            signalClass: 'VIRTUAL_MACHINE_DETECTED',
            metadata: { hypervisor: 'VMware Workstation' },
          },
        ],
      });
    expect(signalRes.status).toBe(202);

    // Verify incidents created in PROCTOR_REVIEW status
    const incidents = await ctx.admin('proctor_incidents')
      .where({ tenant_id: t.tenantId, attempt_id: attemptId })
      .select('signal_class', 'status');
    expect(incidents.length).toBeGreaterThanOrEqual(2);
    for (const inc of incidents) {
      expect(inc.status).toBe('PROCTOR_REVIEW');
    }

    // Invariant: Zero countable warnings created automatically
    const warnings = await ctx.admin('proctor_warnings')
      .where({ tenant_id: t.tenantId, attempt_id: attemptId });
    expect(warnings.length).toBe(0);

    // Attempt status remains unaffected
    const attempt = await ctx.admin('exam_attempts').where({ id: attemptId }).first('status');
    expect(attempt.status).not.toBe('SUSPENDED');
  });

  it('records audit event when staff downloads booklet prior to publication', async () => {
    const now = Date.now();
    const createExam = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({
        code: 'CS405-AUDIT',
        title: 'Audited Exam',
        courseCode: 'CS401',
        examType: 'MID_1',
        securityProfile: 'BASIC_BROWSER',
        durationMinutes: 60,
        windowStartAt: new Date(now - 7200_000).toISOString(),
        windowEndAt: new Date(now - 3600_000).toISOString(),
        policy: {},
      });
    const examId = createExam.body.examId as string;

    // Exam closed
    await ctx.admin('exams').where({ id: examId }).update({ status: 'CLOSED' });

    const attemptId = await allocateStudent(examId, student1.userId, 'SUBMITTED');

    // Create candidate review packet in pre-publication status
    await ctx.admin('candidate_review_packets').insert({
      id: randomUUID(),
      tenant_id: t.tenantId,
      attempt_id: attemptId,
      exam_id: examId,
      user_id: student1.userId,
      status: 'ACADEMIC_MARKING_READY',
    });

    // Staff downloads booklet PDF prior to publication
    const dlRes = await req()
      .get(`/api/v1/candidates/${attemptId}/booklet.pdf`)
      .set(H(examCell.token));
    expect(dlRes.status).toBe(200);

    // Verify audit event written
    const auditRow = await ctx.admin('audit_events')
      .where({ tenant_id: t.tenantId, action: 'booklet.downloaded', entity_id: attemptId })
      .first();
    expect(auditRow).toBeDefined();
    expect(auditRow.actor_id).toBe(examCell.userId);
    expect(auditRow.metadata.isPrePublication).toBe(true);
  });

  it('camera presence check: opt-in per exam, adds camera consent, starts a new policy version, frozen once live', async () => {
    const now = Date.now();
    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'CS403-CAM', title: 'Camera presence', courseCode: 'CS401', examType: 'MID_1', securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: new Date(now - 60_000).toISOString(), windowEndAt: new Date(now + 3600_000).toISOString() });
    const examId = create.body.examId as string;
    const attemptId = await allocateStudent(examId, student2.userId);
    await ctx.admin('exams').where({ id: examId }).update({ status: 'PRECHECK' });
    const policyOf = () => req().get(`/api/v1/student/attempts/${attemptId}/policy`).set(H(student2.token));
    const before = await policyOf();
    expect(before.body).toMatchObject({ cameraPresence: false, consentPurposes: [] });

    const on = await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ cameraPresence: true });
    expect(on.status).toBe(200);
    const after = await policyOf();
    expect(after.body.cameraPresence).toBe(true);
    expect(after.body.consentPurposes).toEqual(['CAMERA']);
    expect(after.body.checks.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['CAMERA', 'CONSENT']));
    // what students consent to changed, so earlier readiness runs no longer admit anyone
    expect(after.body.policyVersion).not.toBe(before.body.policyVersion);
    // repeating the same value is not a new version
    await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ cameraPresence: true });
    expect((await policyOf()).body.policyVersion).toBe(after.body.policyVersion);

    await ctx.admin('exams').where({ id: examId }).update({ status: 'LIVE' });
    const frozen = await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ cameraPresence: false });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('POLICY_FROZEN');
  });
});

/** Minimal XML property-list reader (dict, array, string, integer, true, false) — independent of the generator. */
function parsePlist(xml: string): unknown {
  const tokens = [...xml.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, '').matchAll(/<(\/?)(\w+)(\/?)>([^<]*)/g)].map((m) => ({ close: m[1] === '/', tag: m[2]!, selfClose: m[3] === '/', text: m[4]! }));
  let i = 0;
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const value = (): unknown => {
    const tok = tokens[i++]!;
    if (tok.tag === 'plist') return value();
    if (tok.tag === 'true' || tok.tag === 'false') return tok.tag === 'true';
    if (tok.tag === 'string') return i++, unescape(tok.text);
    if (tok.tag === 'integer') return i++, Number(tok.text);
    if (tok.tag === 'array') {
      const out: unknown[] = [];
      if (tok.selfClose) return out;
      while (!(tokens[i]!.close && tokens[i]!.tag === 'array')) out.push(value());
      i++;
      return out;
    }
    if (tok.tag === 'dict') {
      const out: Record<string, unknown> = {};
      while (!(tokens[i]!.close && tokens[i]!.tag === 'dict')) {
        const key = unescape(tokens[i]!.text);
        i += 2;
        out[key] = value();
      }
      i++;
      return out;
    }
    throw new Error(`unexpected ${tok.tag}`);
  };
  return value();
}

/** SEB Config Key: JSON without originatorVersion, keys sorted case-insensitively at every level, SHA-256 hex. */
function sebKeyOf(settings: Record<string, unknown>): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en', { sensitivity: 'base' }) || 0).map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  const { originatorVersion: _o, ...rest } = settings;
  void _o;
  return sha256Hex(JSON.stringify(sort(rest)));
}
