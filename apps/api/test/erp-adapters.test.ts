import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTestContext,
  provisionTenant,
  startFakeServer,
  type TestContext,
  type ProvisionedTenant,
} from './helpers.js';
import { AcsEmailTransport } from '../src/modules/notifications/transports/acs-email.js';
import { SesTransport } from '../src/modules/notifications/transports/ses.js';

describe('Phase 7: ERP Adapters, XLSX Import & Mail Completeness', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let uosServer: { url: string; close: () => Promise<void> };
  let genericServer: { url: string; close: () => Promise<void> };
  let acsServer: { url: string; close: () => Promise<void> };
  let sesServer: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'p7');

    // 1. Fake UOS Server
    uosServer = await startFakeServer((app) => {
      app.get('/api/v1/academic-units', (_req, res) => {
        res.json([
          { code: 'CSE', name: 'Computer Science', kind: 'DEPARTMENT', status: 'ACTIVE' },
          { code: 'BTECH-CSE', name: 'B.Tech CSE', kind: 'PROGRAMME', parentCode: 'CSE', status: 'ACTIVE' },
        ]);
      });
      app.get('/api/v1/courses', (_req, res) => {
        res.json([
          { code: 'CS101', name: 'Intro to Programming', departmentCode: 'CSE', credits: 4, status: 'ACTIVE' },
        ]);
      });
      app.get('/api/v1/persons', (_req, res) => {
        res.json([
          {
            externalId: 'UOS-001',
            email: `uos.student1@${t.slug}.test`,
            fullName: 'UOS Student 1',
            kind: 'STUDENT',
            status: 'ACTIVE',
            departmentCode: 'CSE',
            programmeCode: 'BTECH-CSE',
            currentSemester: 1,
          },
          {
            externalId: 'UOS-002',
            email: `uos.student2@${t.slug}.test`,
            fullName: 'UOS Student 2',
            kind: 'STUDENT',
            status: 'ACTIVE',
            departmentCode: 'CSE',
            programmeCode: 'BTECH-CSE',
            currentSemester: 1,
          },
        ]);
      });
      app.get('/api/v1/enrollments', (_req, res) => {
        res.json([
          {
            studentExternalId: 'UOS-001',
            courseCode: 'CS101',
            academicYear: '2025-26',
            term: 'SEM_1',
            eligibilityStatus: 'ELIGIBLE',
          },
        ]);
      });
    });

    // 2. Fake Generic REST Server
    genericServer = await startFakeServer((app) => {
      app.get('/external/users', (_req, res) => {
        res.json({
          items: [
            {
              emp_id: 'GEN-001',
              mail: `gen.student1@${t.slug}.test`,
              name: 'Generic Student 1',
              role: 'STUDENT',
              state: 'ACTIVE',
            },
          ],
        });
      });
    });

    // 3. Fake ACS Server
    acsServer = await startFakeServer((app) => {
      app.post('/emails:send', (_req, res) => {
        res.setHeader('operation-id', 'acs-op-12345678');
        res.status(202).json({ id: 'acs-msg-999' });
      });
    });

    // 4. Fake SES Server
    sesServer = await startFakeServer((app) => {
      app.post('/v2/email/outbound-emails', (_req, res) => {
        res.status(200).json({ MessageId: 'ses-msg-88888888' });
      });
    });
  });

  afterAll(async () => {
    await uosServer.close();
    await genericServer.close();
    await acsServer.close();
    await sesServer.close();
    await ctx.close();
  });

  const call = () => ctx.request();
  const staffAuth = () => ({
    Host: t.host,
    Authorization: `Bearer ${t.admin.token}`,
  });

  // ---------------------------------------------------------------- ERP Connections
  it('manages ERP connections with credentials sealed and isolated by tenant', async () => {
    const createRes = await call()
      .post('/api/v1/tenant/erp-connections')
      .set(staffAuth())
      .send({
        provider: 'uos',
        label: 'Main Campus UOS',
        baseUrl: uosServer.url,
        credentialSecret: 'super-secret-token',
        status: 'ACTIVE',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeDefined();
    const connId = createRes.body.id as string;

    const listRes = await call()
      .get('/api/v1/tenant/erp-connections')
      .set(staffAuth());
    expect(listRes.status).toBe(200);
    expect(listRes.body.connections.length).toBeGreaterThanOrEqual(1);
    const found = listRes.body.connections.find((c: { id: string }) => c.id === connId);
    expect(found.label).toBe('Main Campus UOS');
    expect(found.credential_ref).toBeUndefined(); // never leaked!

    const updateRes = await call()
      .put(`/api/v1/tenant/erp-connections/${connId}`)
      .set(staffAuth())
      .send({ label: 'Main Campus UOS v2' });
    expect(updateRes.status).toBe(204);

    const getRes = await call()
      .get(`/api/v1/tenant/erp-connections/${connId}`)
      .set(staffAuth());
    expect(getRes.status).toBe(200);
    expect(getRes.body.connection.label).toBe('Main Campus UOS v2');
  });

  // ---------------------------------------------------------------- UOS Pull Adapter
  it('runs UOS pull sync with dry-run preview and live execution', async () => {
    const connRes = await call()
      .post('/api/v1/tenant/erp-connections')
      .set(staffAuth())
      .send({
        provider: 'uos',
        label: 'UOS Production',
        baseUrl: uosServer.url,
        credentialSecret: 'uos-bearer-token',
      });
    const connId = connRes.body.id;

    // 1. Dry run
    const dryRunRes = await call()
      .post(`/api/v1/tenant/erp-connections/${connId}/sync`)
      .set(staffAuth())
      .send({ entity: 'ALL', mode: 'UPSERT', dryRun: true });

    expect(dryRunRes.status).toBe(200);
    expect(dryRunRes.body.dryRun).toBe(true);
    expect(dryRunRes.body.summary.created).toBeGreaterThan(0);
    expect(dryRunRes.body.summary.identityConflicts).toBe(0);

    // Verify DB has not inserted yet
    const preCheck = await ctx.admin('external_identities').where({
      tenant_id: t.tenantId,
      external_id: 'UOS-001',
    }).first();
    expect(preCheck).toBeUndefined();

    // 2. Live sync
    const liveRes = await call()
      .post(`/api/v1/tenant/erp-connections/${connId}/sync`)
      .set(staffAuth())
      .send({ entity: 'ALL', mode: 'UPSERT', dryRun: false });

    expect(liveRes.status).toBe(200);
    expect(liveRes.body.dryRun).toBe(false);
    expect(liveRes.body.results.persons.summary.created).toBe(2);
    expect(liveRes.body.results.academicUnits.summary.created).toBe(2);
    expect(liveRes.body.results.courses.summary.created).toBe(1);
    expect(liveRes.body.results.enrollments.summary.created).toBe(1);

    // Verify DB records
    const identity = await ctx.admin('external_identities').where({
      tenant_id: t.tenantId,
      external_id: 'UOS-001',
    }).first();
    expect(identity).toBeDefined();

    // Check last_sync_at updated
    const updatedConn = await ctx.admin('tenant_erp_connections').where({ id: connId }).first();
    expect(updatedConn.last_sync_at).not.toBeNull();

    // Check past sync jobs list
    const jobsRes = await call()
      .get(`/api/v1/tenant/erp-connections/${connId}/jobs`)
      .set(staffAuth());
    expect(jobsRes.status).toBe(200);
    expect(jobsRes.body.jobs.length).toBeGreaterThan(0);
    expect(jobsRes.body.jobs[0].source).toBe('ADAPTER');
  });

  // ---------------------------------------------------------------- Generic REST Adapter
  it('pulls and maps custom schemas using generic-rest adapter', async () => {
    const connRes = await call()
      .post('/api/v1/tenant/erp-connections')
      .set(staffAuth())
      .send({
        provider: 'generic-rest',
        label: 'Legacy HR Portal',
        baseUrl: genericServer.url,
        mapping: {
          personsPath: '/external/users',
          fieldMap: {
            emp_id: 'externalId',
            mail: 'email',
            name: 'fullName',
            role: 'kind',
            state: 'status',
          },
        },
      });
    const connId = connRes.body.id;

    const syncRes = await call()
      .post(`/api/v1/tenant/erp-connections/${connId}/sync`)
      .set(staffAuth())
      .send({ entity: 'PERSON', mode: 'UPSERT', dryRun: false });

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.results.persons.summary.created).toBe(1);

    const person = await ctx.admin('external_identities').where({
      tenant_id: t.tenantId,
      external_id: 'GEN-001',
    }).first();
    expect(person).toBeDefined();
  });

  // ---------------------------------------------------------------- XLSX / CSV Ingestion
  it('downloads CSV templates, validates preview, detects identity conflicts, and imports roster', async () => {
    // 1. Download template
    const templateRes = await call()
      .get('/api/v1/tenant/roster/templates/PERSON')
      .set(staffAuth());
    expect(templateRes.status).toBe(200);
    expect(templateRes.header['content-type']).toContain('text/csv');
    expect(templateRes.text).toContain('externalId,email,fullName');

    // 2. Preview valid CSV
    const csvContent = [
      'externalId,email,fullName,kind,status',
      `CSV-001,csv.one@${t.slug}.test,CSV Person One,STUDENT,ACTIVE`,
      `CSV-002,csv.two@${t.slug}.test,CSV Person Two,STUDENT,ACTIVE`,
    ].join('\n');

    const previewRes = await call()
      .post('/api/v1/tenant/roster/preview')
      .set(staffAuth())
      .send({
        entity: 'PERSON',
        csvContent,
        mode: 'UPSERT',
      });
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.summary.created).toBe(2);
    expect(previewRes.body.summary.identityConflicts).toBe(0);

    // 3. Identity conflict detection:
    // Create someone with email csv.conflict@tenant.test and externalId 'ORIGINAL-ID'
    await call()
      .post('/api/v1/tenant/roster/import')
      .set(staffAuth())
      .send({
        entity: 'PERSON',
        csvContent: `externalId,email,fullName,kind,status\nORIG-1,csv.conflict@${t.slug}.test,Original Name,STUDENT,ACTIVE`,
      });

    // Now upload CSV with same email but DIFFERENT externalId 'NEW-DIFF-ID'
    const conflictPreview = await call()
      .post('/api/v1/tenant/roster/preview')
      .set(staffAuth())
      .send({
        entity: 'PERSON',
        csvContent: `externalId,email,fullName,kind,status\nDIFF-ID,csv.conflict@${t.slug}.test,Impostor Name,STUDENT,ACTIVE`,
      });
    expect(conflictPreview.status).toBe(200);
    expect(conflictPreview.body.summary.identityConflicts).toBe(1);
    expect(conflictPreview.body.sampleRows[0].outcome).toBe('IDENTITY_CONFLICT');

    // 4. Live import execution
    const importRes = await call()
      .post('/api/v1/tenant/roster/import')
      .set(staffAuth())
      .send({
        entity: 'PERSON',
        csvContent,
        mode: 'UPSERT',
        sourceLabel: 'Admissions Semester 1 CSV',
      });
    expect(importRes.status).toBe(200);
    expect(importRes.body.summary.created).toBe(2);

    const job = await ctx.admin('roster_sync_jobs').where({ id: importRes.body.syncJobId }).first();
    expect(job.source).toBe('XLSX');
    expect(job.source_label).toBe('Admissions Semester 1 CSV');

    // 5. Query roster sync jobs
    const jobsRes = await call()
      .get('/api/v1/tenant/roster/sync-jobs?source=XLSX')
      .set(staffAuth());
    expect(jobsRes.status).toBe(200);
    expect(jobsRes.body.jobs.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------- Mail Completeness & Bounces
  it('supports ACS Email & SES transports, reconciles bounces, and tracks quota health', async () => {
    // 1. Direct transport verification for acs-email
    const acsTransport = new AcsEmailTransport(ctx.deps.fetch);
    const acsOutcome = await acsTransport.send(
      {
        id: randomUUID(),
        tenant_id: t.tenantId,
        category: 'NOTIFICATION',
        lane: 'BULK',
        to_address: `student.acs@${t.slug}.test`,
        to_name: 'ACS Student',
        subject: 'Hall Ticket Notice',
        body_html: '<p>Your hall ticket is ready.</p>',
        body_text: 'Your hall ticket is ready.',
        attempt_count: 0,
      },
      {
        transportKind: 'acs-email',
        senderAddress: `exam@${t.slug}.test`,
        senderName: 'Exam Section',
        endpoint: `${acsServer.url}/emails:send`,
        settings: {},
      },
    );
    expect(acsOutcome.outcome).toBe('ACCEPTED');
    if (acsOutcome.outcome === 'ACCEPTED') {
      expect(acsOutcome.providerMessageId).toBe('acs-op-12345678');
    }

    // 2. Direct transport verification for ses
    const sesTransport = new SesTransport(ctx.deps.fetch);
    const sesOutcome = await sesTransport.send(
      {
        id: randomUUID(),
        tenant_id: t.tenantId,
        category: 'NOTIFICATION',
        lane: 'BULK',
        to_address: `student.ses@${t.slug}.test`,
        to_name: 'SES Student',
        subject: 'Results Published',
        body_html: '<p>Your results are out.</p>',
        body_text: 'Your results are out.',
        attempt_count: 0,
      },
      {
        transportKind: 'ses',
        senderAddress: `exam@${t.slug}.test`,
        senderName: 'Exam Section',
        endpoint: `${sesServer.url}/v2/email/outbound-emails`,
        settings: {},
      },
    );
    expect(sesOutcome.outcome).toBe('ACCEPTED');
    if (sesOutcome.outcome === 'ACCEPTED') {
      expect(sesOutcome.providerMessageId).toBe('ses-msg-88888888');
    }

    // 3. Create a mail dispatch in ACCEPTED status
    const testToAddress = `bouncy.student@${t.slug}.test`;
    const [dispatch] = await ctx.admin('mail_dispatches')
      .insert({
        tenant_id: t.tenantId,
        category: 'EXAM_ALERT',
        lane: 'BULK',
        template_code: 'ACCOUNT_ACTIVATION',
        template_version: 1,
        to_address: testToAddress,
        subject: 'Urgent Examination Schedule',
        body_html: '<p>Important update</p>',
        body_text: 'Important update',
        dedupe_key: `dedupe-${randomUUID()}`,
        status: 'ACCEPTED',
        transport_kind: 'acs-email',
        provider_message_id: 'provider-msg-777',
      })
      .returning('*');

    // 4. Reconcile bounce via staff route
    const bounceRes = await call()
      .post('/api/v1/tenant/mail/bounces')
      .set(staffAuth())
      .send({
        providerMessageId: 'provider-msg-777',
        toAddress: testToAddress,
        reason: '550 5.1.1 User unknown mailbox not found',
      });
    expect(bounceRes.status).toBe(200);
    expect(bounceRes.body.reconciled).toBe(true);
    expect(bounceRes.body.dispatchId).toBe(dispatch.id);

    // Verify DB dispatch status is BOUNCED
    const updatedDispatch = await ctx.admin('mail_dispatches').where({ id: dispatch.id }).first();
    expect(updatedDispatch.status).toBe('BOUNCED');
    expect(updatedDispatch.last_error).toContain('User unknown');

    // Verify audit event
    const auditRow = await ctx.admin('audit_events')
      .where({ tenant_id: t.tenantId, entity_id: dispatch.id, action: 'mail.bounced' })
      .first();
    expect(auditRow).toBeDefined();

    // 5. Check Mail Health & Quota Dashboard
    const healthRes = await call()
      .get('/api/v1/tenant/mail/health')
      .set(staffAuth());
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.bounced).toBeGreaterThanOrEqual(1);
    expect(healthRes.body.bounceRatePct).toBeGreaterThan(0);
    expect(healthRes.body.dailyExternalQuota).toBeDefined();
    expect(healthRes.body.dailyExternalQuota.limit).toBe(2000);
    expect(healthRes.body.dailyExternalQuota.remaining).toBeLessThanOrEqual(2000);
  });
});
