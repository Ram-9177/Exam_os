import type { Knex } from '@examos/db';
import type { Person, AcademicUnit, Course, Enrollment, RosterBatchResponse } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { createUserWithActivation } from '../users/service.js';
import { audit } from '../../lib/audit.js';
import { recordIntegrationEvent } from './events.js';

type Mode = 'UPSERT' | 'CREATE_ONLY' | 'UPDATE_ONLY';
type RowResult = RosterBatchResponse['rows'][number];

export interface RosterActor {
  tenantId: string;
  provider: string;
  source: 'PUSH_API' | 'XLSX' | 'ADAPTER';
  apiKeyId?: string | null;
  connectionId?: string | null;
  actorUserId?: string | null;
  sourceLabel?: string;
}

async function openJob(trx: Knex.Transaction, actor: RosterActor, entity: 'PERSON' | 'ACADEMIC_UNIT' | 'COURSE' | 'ENROLLMENT', mode: Mode): Promise<string> {
  const [job] = await trx('roster_sync_jobs')
    .insert({ tenant_id: actor.tenantId, source: actor.source, connection_id: actor.connectionId ?? null, api_key_id: actor.apiKeyId ?? null, actor_user_id: actor.actorUserId ?? null, entity, mode, source_label: actor.sourceLabel ?? null })
    .returning('id');
  return job.id as string;
}

async function closeJob(trx: Knex.Transaction, actor: RosterActor, jobId: string, entity: string, rows: RowResult[]): Promise<RosterBatchResponse> {
  const summary = {
    created: rows.filter((r) => r.outcome === 'CREATED').length,
    updated: rows.filter((r) => r.outcome === 'UPDATED').length,
    unchanged: rows.filter((r) => r.outcome === 'UNCHANGED').length,
    rejected: rows.filter((r) => r.outcome === 'REJECTED').length,
    identityConflicts: rows.filter((r) => r.outcome === 'IDENTITY_CONFLICT').length,
  };
  const status = summary.rejected + summary.identityConflicts > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  await trx('roster_sync_jobs').where('id', jobId).update({ status, summary: JSON.stringify(summary), completed_at: trx.fn.now() });
  if (rows.length) {
    await trx('roster_sync_rows').insert(
      rows.map((r) => ({ tenant_id: actor.tenantId, job_id: jobId, row_index: r.index, external_id: r.externalId ?? null, outcome: r.outcome, code: r.code ?? null, message: r.message ?? null })),
    );
  }
  await audit(trx, { tenantId: actor.tenantId, actorType: actor.apiKeyId ? 'API_KEY' : actor.actorUserId ? 'USER' : 'SYSTEM', actorId: actor.apiKeyId ?? actor.actorUserId ?? null, action: 'roster.sync.completed', entityType: 'roster_sync_job', entityId: jobId, metadata: { entity, ...summary } });
  await recordIntegrationEvent(trx, { tenantId: actor.tenantId, type: 'roster.sync.completed', aggregateType: 'roster_sync_job', aggregateId: jobId, data: { syncJobId: jobId, entity, source: actor.source, summary } });
  return { syncJobId: jobId, summary, rows };
}

/**
 * Person upsert keyed strictly by (provider, externalId). An e-mail that already
 * belongs to a different identity of the same provider is an IDENTITY_CONFLICT
 * and halts that row (review §5) — e-mail is never used to merge people.
 */
export async function upsertPersons(deps: AppDeps, trx: Knex.Transaction, actor: RosterActor, rows: Person[], mode: Mode): Promise<RosterBatchResponse> {
  const jobId = await openJob(trx, actor, 'PERSON', mode);
  const results: RowResult[] = [];
  for (const [index, p] of rows.entries()) {
    try {
      const identity = await trx('external_identities').where({ tenant_id: actor.tenantId, provider: actor.provider, external_id: p.externalId }).first();
      const emailOwner = await trx('users').where({ tenant_id: actor.tenantId, email: p.email }).first('id');
      if (identity) {
        if (mode === 'CREATE_ONLY') {
          results.push({ index, externalId: p.externalId, outcome: 'UNCHANGED', code: 'EXISTS' });
          continue;
        }
        if (emailOwner && emailOwner.id !== identity.user_id) {
          results.push({ index, externalId: p.externalId, outcome: 'IDENTITY_CONFLICT', code: 'EMAIL_BELONGS_TO_OTHER_IDENTITY', message: `e-mail ${p.email} is attached to another person` });
          continue;
        }
        const user = await trx('users').where('id', identity.user_id).first();
        const changes: Record<string, unknown> = {};
        if (user.full_name !== p.fullName) changes['full_name'] = p.fullName;
        if (user.email !== p.email) changes['email'] = p.email;
        const newStatus = p.status === 'ACTIVE' ? (user.status === 'PENDING_ACTIVATION' ? 'PENDING_ACTIVATION' : 'ACTIVE') : p.status;
        if (user.status !== newStatus) changes['status'] = newStatus;
        if (Object.keys(changes).length) await trx('users').where('id', user.id).update({ ...changes, updated_at: trx.fn.now() });
        if (p.kind === 'STUDENT') await upsertStudentProfile(trx, actor.tenantId, user.id, p);
        results.push({ index, externalId: p.externalId, outcome: Object.keys(changes).length ? 'UPDATED' : 'UNCHANGED' });
      } else {
        if (mode === 'UPDATE_ONLY') {
          results.push({ index, externalId: p.externalId, outcome: 'REJECTED', code: 'NOT_FOUND', message: 'UPDATE_ONLY: no such person' });
          continue;
        }
        if (emailOwner) {
          results.push({ index, externalId: p.externalId, outcome: 'IDENTITY_CONFLICT', code: 'EMAIL_BELONGS_TO_OTHER_IDENTITY', message: `e-mail ${p.email} already exists with a different external id` });
          continue;
        }
        const { userId } = await createUserWithActivation(deps, trx, {
          tenantId: actor.tenantId,
          email: p.email,
          fullName: p.fullName,
          kind: p.kind,
          externalId: p.externalId,
          provider: actor.provider,
          roles: p.kind === 'STUDENT' ? [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }] : [],
          grantedBy: actor.actorUserId ?? null,
          sendActivation: p.status === 'ACTIVE',
        });
        if (p.kind === 'STUDENT') await upsertStudentProfile(trx, actor.tenantId, userId, p);
        results.push({ index, externalId: p.externalId, outcome: 'CREATED' });
      }
    } catch (e) {
      results.push({ index, externalId: p.externalId, outcome: 'REJECTED', code: 'ERROR', message: e instanceof Error ? e.message : 'unknown error' });
    }
  }
  return closeJob(trx, actor, jobId, 'PERSON', results);
}

async function upsertStudentProfile(trx: Knex.Transaction, tenantId: string, userId: string, p: Person): Promise<void> {
  const dept = p.departmentCode ? await trx('departments').where({ tenant_id: tenantId, code: p.departmentCode }).first('id') : null;
  const prog = p.programmeCode ? await trx('programmes').where({ tenant_id: tenantId, code: p.programmeCode }).first('id') : null;
  const registerNumber = typeof p.attributes?.['registerNumber'] === 'string' ? (p.attributes['registerNumber'] as string) : null;
  const row = {
    tenant_id: tenantId,
    user_id: userId,
    department_id: dept?.id ?? null,
    programme_id: prog?.id ?? null,
    admission_batch: p.admissionBatch ?? null,
    current_semester: p.currentSemester ?? null,
    section: p.section ?? null,
    register_number: registerNumber,
    preferred_language: p.preferredLanguage ?? null,
    attributes: JSON.stringify(p.attributes ?? {}),
    updated_at: trx.fn.now(),
  };
  await trx('student_profiles').insert(row).onConflict('user_id').merge();
}

export async function upsertAcademicUnits(trx: Knex.Transaction, actor: RosterActor, rows: AcademicUnit[], mode: Mode): Promise<RosterBatchResponse> {
  const jobId = await openJob(trx, actor, 'ACADEMIC_UNIT', mode);
  const results: RowResult[] = [];
  for (const [index, u] of rows.entries()) {
    try {
      if (u.kind === 'DEPARTMENT') {
        const school = u.parentCode ? await trx('schools').where({ tenant_id: actor.tenantId, code: u.parentCode }).first('id') : null;
        if (u.parentCode && !school) {
          // create the school on the fly so hierarchy imports can be order-independent
          const [s] = await trx('schools').insert({ tenant_id: actor.tenantId, code: u.parentCode, name: u.parentCode }).onConflict(['tenant_id', 'code']).merge({ updated_at: trx.fn.now() }).returning('id');
          results.push(await upsertByCode(trx, 'departments', actor.tenantId, u, mode, index, { school_id: s.id }));
        } else {
          results.push(await upsertByCode(trx, 'departments', actor.tenantId, u, mode, index, { school_id: school?.id ?? null }));
        }
      } else {
        const dept = u.parentCode ? await trx('departments').where({ tenant_id: actor.tenantId, code: u.parentCode }).first('id') : null;
        results.push(await upsertByCode(trx, 'programmes', actor.tenantId, u, mode, index, { department_id: dept?.id ?? null }));
      }
    } catch (e) {
      results.push({ index, externalId: u.code, outcome: 'REJECTED', code: 'ERROR', message: e instanceof Error ? e.message : 'unknown error' });
    }
  }
  return closeJob(trx, actor, jobId, 'ACADEMIC_UNIT', results);
}

async function upsertByCode(trx: Knex.Transaction, table: string, tenantId: string, u: { code: string; name: string; status: string }, mode: Mode, index: number, extra: Record<string, unknown>): Promise<RowResult> {
  const existing = await trx(table).where({ tenant_id: tenantId, code: u.code }).first();
  if (existing) {
    if (mode === 'CREATE_ONLY') return { index, externalId: u.code, outcome: 'UNCHANGED', code: 'EXISTS' };
    const changed = existing.name !== u.name || existing.status !== u.status || Object.entries(extra).some(([k, v]) => (existing[k] ?? null) !== (v ?? null));
    if (changed) await trx(table).where('id', existing.id).update({ name: u.name, status: u.status, ...extra, updated_at: trx.fn.now() });
    return { index, externalId: u.code, outcome: changed ? 'UPDATED' : 'UNCHANGED' };
  }
  if (mode === 'UPDATE_ONLY') return { index, externalId: u.code, outcome: 'REJECTED', code: 'NOT_FOUND' };
  await trx(table).insert({ tenant_id: tenantId, code: u.code, name: u.name, status: u.status, ...extra });
  return { index, externalId: u.code, outcome: 'CREATED' };
}

export async function upsertCourses(trx: Knex.Transaction, actor: RosterActor, rows: Course[], mode: Mode): Promise<RosterBatchResponse> {
  const jobId = await openJob(trx, actor, 'COURSE', mode);
  const results: RowResult[] = [];
  for (const [index, c] of rows.entries()) {
    try {
      const dept = await trx('departments').where({ tenant_id: actor.tenantId, code: c.departmentCode }).first('id');
      if (!dept) {
        results.push({ index, externalId: c.code, outcome: 'REJECTED', code: 'DEPARTMENT_NOT_FOUND', message: `department ${c.departmentCode} unknown` });
        continue;
      }
      results.push(await upsertByCode(trx, 'courses', actor.tenantId, c, mode, index, { department_id: dept.id, credits: c.credits ?? null }));
    } catch (e) {
      results.push({ index, externalId: c.code, outcome: 'REJECTED', code: 'ERROR', message: e instanceof Error ? e.message : 'unknown error' });
    }
  }
  return closeJob(trx, actor, jobId, 'COURSE', results);
}

export async function upsertEnrollments(trx: Knex.Transaction, actor: RosterActor, rows: Enrollment[], mode: Mode): Promise<RosterBatchResponse> {
  const jobId = await openJob(trx, actor, 'ENROLLMENT', mode);
  const results: RowResult[] = [];
  for (const [index, e] of rows.entries()) {
    try {
      const identity = await trx('external_identities').where({ tenant_id: actor.tenantId, provider: actor.provider, external_id: e.studentExternalId }).first('user_id');
      if (!identity) {
        results.push({ index, externalId: e.studentExternalId, outcome: 'REJECTED', code: 'STUDENT_NOT_FOUND', message: 'student must be synced before enrolments' });
        continue;
      }
      const course = await trx('courses').where({ tenant_id: actor.tenantId, code: e.courseCode }).first('id');
      if (!course) {
        results.push({ index, externalId: e.studentExternalId, outcome: 'REJECTED', code: 'COURSE_NOT_FOUND', message: `course ${e.courseCode} unknown` });
        continue;
      }
      const key = { tenant_id: actor.tenantId, user_id: identity.user_id, course_id: course.id, academic_year: e.academicYear, term: e.term };
      const existing = await trx('course_enrollments').where(key).first();
      if (existing) {
        if (mode === 'CREATE_ONLY') {
          results.push({ index, externalId: e.studentExternalId, outcome: 'UNCHANGED', code: 'EXISTS' });
          continue;
        }
        const changed = existing.section !== (e.section ?? null) || existing.eligibility_status !== e.eligibilityStatus;
        if (changed) await trx('course_enrollments').where('id', existing.id).update({ section: e.section ?? null, eligibility_status: e.eligibilityStatus, updated_at: trx.fn.now() });
        results.push({ index, externalId: e.studentExternalId, outcome: changed ? 'UPDATED' : 'UNCHANGED' });
      } else {
        if (mode === 'UPDATE_ONLY') {
          results.push({ index, externalId: e.studentExternalId, outcome: 'REJECTED', code: 'NOT_FOUND' });
          continue;
        }
        await trx('course_enrollments').insert({ ...key, section: e.section ?? null, eligibility_status: e.eligibilityStatus, source: actor.source });
        results.push({ index, externalId: e.studentExternalId, outcome: 'CREATED' });
      }
    } catch (err) {
      results.push({ index, externalId: e.studentExternalId, outcome: 'REJECTED', code: 'ERROR', message: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return closeJob(trx, actor, jobId, 'ENROLLMENT', results);
}
