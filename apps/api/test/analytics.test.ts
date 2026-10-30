import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, type TestContext, type ProvisionedTenant } from './helpers.js';

describe('Phase 3 — Student Profile, ID Card, and Department Analytics', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();

  let deptCseId: string;
  let deptEceId: string;
  let progCseId: string;
  let progEceId: string;
  let courseCseId: string;

  let student1: { userId: string; email: string; token: string; registerNumber: string };
  let student2: { userId: string; email: string; token: string; registerNumber: string };
  let studentEce: { userId: string; email: string; token: string; registerNumber: string };

  let hodCse: { userId: string; email: string; token: string };
  let hodEce: { userId: string; email: string; token: string };
  let examCell: { userId: string; email: string; token: string };
  let controller: { userId: string; email: string; token: string };

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'smru-profile');

    // 1. Create Academic Hierarchy: Schools & Departments
    const [school] = await ctx.admin('schools').insert({
      id: randomUUID(),
      tenant_id: t.tenantId,
      code: 'SOET',
      name: 'School of Engineering & Technology',
    }).returning('id');

    deptCseId = randomUUID();
    await ctx.admin('departments').insert({
      id: deptCseId,
      tenant_id: t.tenantId,
      school_id: school.id,
      code: 'CSE',
      name: 'Computer Science and Engineering',
    });

    deptEceId = randomUUID();
    await ctx.admin('departments').insert({
      id: deptEceId,
      tenant_id: t.tenantId,
      school_id: school.id,
      code: 'ECE',
      name: 'Electronics and Communication Engineering',
    });

    progCseId = randomUUID();
    await ctx.admin('programmes').insert({
      id: progCseId,
      tenant_id: t.tenantId,
      department_id: deptCseId,
      code: 'BTECH_CSE',
      name: 'B.Tech in Computer Science',
    });

    progEceId = randomUUID();
    await ctx.admin('programmes').insert({
      id: progEceId,
      tenant_id: t.tenantId,
      department_id: deptEceId,
      code: 'BTECH_ECE',
      name: 'B.Tech in Electronics',
    });

    courseCseId = randomUUID();
    await ctx.admin('courses').insert({
      id: courseCseId,
      tenant_id: t.tenantId,
      department_id: deptCseId,
      code: 'CS301',
      name: 'Operating Systems',
    });

    // 2. Helper to create and activate user
    async function createUser(email: string, fullName: string, kind: 'STUDENT' | 'STAFF', roles: Array<{ role: string; scopeType?: string; scopeId?: string | null }>) {
      const uRes = await req().post('/api/v1/tenant/users').set(H(t.admin.token)).send({
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

      // Activate
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

    // 3. Create Students
    const s1 = await createUser(`student1-${randomUUID().slice(0, 6)}@${t.slug}.test`, 'Aarav Patel', 'STUDENT', [{ role: 'STUDENT' }]);
    student1 = { ...s1, registerNumber: '2026CSE001' };
    await ctx.admin('student_profiles').where({ tenant_id: t.tenantId, user_id: student1.userId }).update({
      department_id: deptCseId,
      programme_id: progCseId,
      register_number: student1.registerNumber,
      admission_batch: '2024-2028',
      current_semester: 5,
      section: 'A',
    });

    const s2 = await createUser(`student2-${randomUUID().slice(0, 6)}@${t.slug}.test`, 'Diya Sharma', 'STUDENT', [{ role: 'STUDENT' }]);
    student2 = { ...s2, registerNumber: '2026CSE002' };
    await ctx.admin('student_profiles').where({ tenant_id: t.tenantId, user_id: student2.userId }).update({
      department_id: deptCseId,
      programme_id: progCseId,
      register_number: student2.registerNumber,
      admission_batch: '2024-2028',
      current_semester: 5,
      section: 'A',
    });

    const sEce = await createUser(`student-ece-${randomUUID().slice(0, 6)}@${t.slug}.test`, 'Rohan Varma', 'STUDENT', [{ role: 'STUDENT' }]);
    studentEce = { ...sEce, registerNumber: '2026ECE001' };
    await ctx.admin('student_profiles').where({ tenant_id: t.tenantId, user_id: studentEce.userId }).update({
      department_id: deptEceId,
      programme_id: progEceId,
      register_number: studentEce.registerNumber,
      admission_batch: '2024-2028',
      current_semester: 3,
      section: 'B',
    });

    // 4. Create Staff with Scoped and Tenant-wide Roles
    // HOD CSE is scoped specifically to DEPARTMENT deptCseId
    hodCse = await createUser(`hod-cse-${randomUUID().slice(0, 6)}@${t.slug}.test`, 'Dr. Vikram Sen (HOD CSE)', 'STAFF', [
      { role: 'HOD', scopeType: 'DEPARTMENT', scopeId: deptCseId },
    ]);

    // HOD ECE is scoped specifically to DEPARTMENT deptEceId
    hodEce = await createUser(`hod-ece-${randomUUID().slice(0, 6)}@${t.slug}.test`, 'Dr. Ananya Roy (HOD ECE)', 'STAFF', [
      { role: 'HOD', scopeType: 'DEPARTMENT', scopeId: deptEceId },
    ]);

    // Tenant-wide Exam Cell & Controller
    examCell = await createUser(`examcell-${randomUUID().slice(0, 6)}@${t.slug}.test`, 'Exam Cell Officer', 'STAFF', [
      { role: 'EXAM_CELL_OPERATOR' },
    ]);
    controller = { userId: t.admin.userId, email: t.admin.email, token: t.admin.token } as typeof controller; // admin login holds CONTROLLER
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('retrieves student profile, enforces photo consent, stores photo, and validates photo binary download', async () => {
    // 1. Student 1 fetches profile
    const profRes = await req().get('/api/v1/student/profile').set(H(student1.token));
    expect(profRes.status).toBe(200);
    expect(profRes.body.student.fullName).toBe('Aarav Patel');
    expect(profRes.body.student.registerNumber).toBe('2026CSE001');
    expect(profRes.body.department.code).toBe('CSE');
    expect(profRes.body.programme.code).toBe('BTECH_CSE');
    expect(profRes.body.documents.photo).toBeNull();

    // 2. Attempt photo upload with consentGiven: false -> Refused with 400
    // 1x1 transparent PNG
    const pngSample = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const noConsentRes = await req().post('/api/v1/student/profile/photo').set(H(student1.token)).send({
      consentGiven: false,
      dataUrl: pngSample,
    });
    expect(noConsentRes.status).toBe(400);

    // 3. Upload photo with consentGiven: true -> 200 OK
    const uploadRes = await req().post('/api/v1/student/profile/photo').set(H(student1.token)).send({
      consentGiven: true,
      dataUrl: pngSample,
    });
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.mimeType).toBe('image/png');
    expect(uploadRes.body.sha256).toBeDefined();
    const photoSha = uploadRes.body.sha256;

    // 4. Download photo binary stream
    const photoRes = await req().get('/api/v1/student/profile/photo').set(H(student1.token));
    expect(photoRes.status).toBe(200);
    expect(photoRes.headers['content-type']).toBe('image/png');
    expect(photoRes.headers['x-document-sha256']).toBe(photoSha);
    expect(photoRes.body).toBeInstanceOf(Buffer);

    // 5. Profile now reflects photo document
    const updatedProf = await req().get('/api/v1/student/profile').set(H(student1.token));
    expect(updatedProf.body.documents.photo).toMatchObject({
      sha256: photoSha,
      mimeType: 'image/png',
    });

    // 6. Audit event committed in database
    const photoAudit = await ctx.admin('audit_events').where({
      tenant_id: t.tenantId,
      action: 'student.photo_uploaded',
      entity_id: student1.userId,
    }).first();
    expect(photoAudit).toBeDefined();
  });

  it('generates verifiable student ID card with QR code and verifies identity publicly', async () => {
    // 1. Student requests ID card data
    const idCardRes = await req().get('/api/v1/student/profile/id-card').set(H(student1.token));
    expect(idCardRes.status).toBe(200);
    expect(idCardRes.body.valid).toBe(true);
    expect(idCardRes.body.fullName).toBe('Aarav Patel');
    expect(idCardRes.body.registerNumber).toBe('2026CSE001');
    expect(idCardRes.body.departmentCode).toBe('CSE');
    expect(idCardRes.body.programmeCode).toBe('BTECH_CSE');
    expect(idCardRes.body.photoAvailable).toBe(true);
    expect(idCardRes.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // 2. Extract verification hash from verification URL embedded in QR or compute hash
    const hash = idCardRes.body.qrDataUrl ? (await (async () => {
      const { computeStudentVerificationHash } = await import('../src/modules/profile/service.js');
      return computeStudentVerificationHash(t.tenantId, student1.userId, '2026CSE001');
    })()) : '';

    // 3. Public identity verification (without authentication)
    const publicVerifyRes = await req().get(`/api/v1/student/verify-student/${hash}`).set('Host', t.host);
    expect(publicVerifyRes.status).toBe(200);
    expect(publicVerifyRes.body.valid).toBe(true);
    expect(publicVerifyRes.body.fullName).toBe('Aarav Patel');
    expect(publicVerifyRes.body.registerNumber).toBe('2026CSE001');
    expect(publicVerifyRes.body.departmentName).toBe('Computer Science and Engineering');

    // 4. Fake hash returns 404
    const fakeVerify = await req().get(`/api/v1/student/verify-student/${'0'.repeat(64)}`).set('Host', t.host);
    expect(fakeVerify.status).toBe(404);
  });

  it('calculates department academic rollups, enforces HOD department scoping, and respects proctoring privacy', async () => {
    // 1. Seed published exam results for CSE students
    const examId = randomUUID();
    const now = new Date();
    await ctx.admin('exams').insert({
      id: examId,
      tenant_id: t.tenantId,
      course_id: courseCseId,
      code: 'CS301-TEST',
      title: 'Operating Systems — Midterm',
      exam_type: 'MID_1',
      academic_year: '2026-27',
      semester: 5,
      status: 'CLOSED',
      duration_minutes: 60,
      window_start_at: new Date(now.getTime() - 7200_000),
      window_end_at: new Date(now.getTime() - 3600_000),
      security_profile: 'BASIC_BROWSER',
      max_marks: 50,
      created_by: examCell.userId,
    });

    const attempt1Id = randomUUID();
    await ctx.admin('exam_attempts').insert({
      id: attempt1Id,
      tenant_id: t.tenantId,
      exam_id: examId,
      user_id: student1.userId,
      attempt_no: 1,
      status: 'SUBMITTED',
    });

    const attempt2Id = randomUUID();
    await ctx.admin('exam_attempts').insert({
      id: attempt2Id,
      tenant_id: t.tenantId,
      exam_id: examId,
      user_id: student2.userId,
      attempt_no: 1,
      status: 'SUBMITTED',
    });

    const rv1Id = randomUUID();
    await ctx.admin('result_versions').insert({
      id: rv1Id,
      tenant_id: t.tenantId,
      attempt_id: attempt1Id,
      version: 1,
      total_marks: 42,
      max_marks: 50,
      items: JSON.stringify([]),
      approved_by: examCell.userId,
    });

    const rv2Id = randomUUID();
    await ctx.admin('result_versions').insert({
      id: rv2Id,
      tenant_id: t.tenantId,
      attempt_id: attempt2Id,
      version: 1,
      total_marks: 18, // 18/50 = 36% (< 40% fail)
      max_marks: 50,
      items: JSON.stringify([]),
      approved_by: examCell.userId,
    });

    // Insert live published records in student_exam_records
    await ctx.admin('student_exam_records').insert([
      {
        id: randomUUID(),
        tenant_id: t.tenantId,
        user_id: student1.userId,
        exam_id: examId,
        attempt_id: attempt1Id,
        result_version_id: rv1Id,
        course_id: courseCseId,
        exam_type: 'MID_1',
        academic_year: '2026-27',
        semester: 5,
        marks: 42,
        max_marks: 50,
        grade: 'A',
        published_at: now,
      },
      {
        id: randomUUID(),
        tenant_id: t.tenantId,
        user_id: student2.userId,
        exam_id: examId,
        attempt_id: attempt2Id,
        result_version_id: rv2Id,
        course_id: courseCseId,
        exam_type: 'MID_1',
        academic_year: '2026-27',
        semester: 5,
        marks: 18,
        max_marks: 50,
        grade: 'F',
        published_at: now,
      },
    ]);

    // 2. HOD CSE accesses their OWN department analytics -> 200 OK
    const cseRes = await req()
      .get(`/api/v1/analytics/department/${deptCseId}`)
      .set(H(hodCse.token));
    expect(cseRes.status).toBe(200);
    expect(cseRes.body.department.code).toBe('CSE');
    expect(cseRes.body.summary.totalStudents).toBe(2);
    expect(cseRes.body.summary.totalPublishedResults).toBe(2);
    expect(cseRes.body.summary.avgPercentage).toBe(60); // (42 + 18) / 100 * 100 = 60%
    expect(cseRes.body.summary.passCount).toBe(1);
    expect(cseRes.body.summary.failCount).toBe(1);
    expect(cseRes.body.summary.passRate).toBe(50); // 1 / 2 = 50%

    // Exam rollups
    expect(cseRes.body.examRollups).toHaveLength(1);
    expect(cseRes.body.examRollups[0].examCode).toBe('CS301-TEST');
    expect(cseRes.body.examRollups[0].highestMarks).toBe(42);
    expect(cseRes.body.examRollups[0].lowestMarks).toBe(18);

    // 3. ABAC SCOPED REFUSAL: HOD CSE requests ECE department analytics -> 403 Forbidden!
    const refusedRes = await req()
      .get(`/api/v1/analytics/department/${deptEceId}`)
      .set(H(hodCse.token));
    expect(refusedRes.status).toBe(403);
    expect(refusedRes.body.code).toBe('PERMISSION_DENIED');

    // 4. HOD ECE accesses ECE department analytics -> 200 OK
    const eceRes = await req()
      .get(`/api/v1/analytics/department/${deptEceId}`)
      .set(H(hodEce.token));
    expect(eceRes.status).toBe(200);
    expect(eceRes.body.department.code).toBe('ECE');
    expect(eceRes.body.summary.totalStudents).toBe(1);
    expect(eceRes.body.summary.totalPublishedResults).toBe(0);

    // 5. Tenant-wide Controller can access department analytics and tenant overview
    const ctlDeptRes = await req()
      .get(`/api/v1/analytics/department/${deptCseId}`)
      .set(H(controller.token));
    expect(ctlDeptRes.status).toBe(200);

    const overviewRes = await req()
      .get('/api/v1/analytics/overview')
      .set(H(controller.token));
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.departments).toBeInstanceOf(Array);
    expect(overviewRes.body.departments.length).toBeGreaterThanOrEqual(2);

    // 6. PROCTORING PRIVACY INVARIANT: Ensure analytics payload never leaks proctoring keys
    const jsonStr = JSON.stringify(cseRes.body).toLowerCase();
    for (const forbidden of ['incident', 'warning', 'proctor', 'devicesession', 'biometric', 'webcam']) {
      expect(jsonStr).not.toContain(forbidden);
    }
  });
});
