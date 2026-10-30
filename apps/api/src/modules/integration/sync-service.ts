import type { Knex } from '@examos/db';
import type {
  ErpConnectionCreateInput,
  ErpConnectionUpdateInput,
  ErpSyncRequestInput,
  RosterBatchResponse,
  Person,
  AcademicUnit,
  Course,
  Enrollment,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { getErpAdapter, type ErpConnectionRow, type ErpPullData } from './adapters/index.js';
import { upsertPersons, upsertAcademicUnits, upsertCourses, upsertEnrollments, type RosterActor } from './roster.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

export async function createErpConnection(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  input: ErpConnectionCreateInput,
  actorUserId?: string | null,
): Promise<{ id: string }> {
  const credentialRef = input.credentialSecret ? deps.secrets.seal(input.credentialSecret) : null;
  const webhookSecretRef = input.webhookSecret ? deps.secrets.seal(input.webhookSecret) : null;

  const [row] = await trx('tenant_erp_connections')
    .insert({
      tenant_id: tenantId,
      provider: input.provider,
      label: input.label,
      base_url: input.baseUrl,
      credential_ref: credentialRef,
      webhook_secret_ref: webhookSecretRef,
      sync_schedule_cron: input.syncScheduleCron ?? null,
      mapping: JSON.stringify(input.mapping ?? {}),
      status: input.status,
    })
    .returning('id');

  await audit(trx, {
    tenantId,
    actorType: actorUserId ? 'USER' : 'SYSTEM',
    actorId: actorUserId ?? null,
    action: 'erp.connection.created',
    entityType: 'tenant_erp_connection',
    entityId: row.id,
    metadata: { provider: input.provider, label: input.label },
  });

  return { id: row.id };
}

export async function listErpConnections(
  trx: Knex.Transaction,
  tenantId: string,
): Promise<Array<Omit<ErpConnectionRow, 'credential_ref' | 'webhook_secret_ref'>>> {
  const rows = await trx<ErpConnectionRow>('tenant_erp_connections')
    .where('tenant_id', tenantId)
    .orderBy('created_at', 'desc')
    .select(
      'id',
      'tenant_id',
      'provider',
      'label',
      'base_url',
      'sync_schedule_cron',
      'mapping',
      'status',
      'last_sync_at',
      'created_at',
      'updated_at',
    );
  return rows;
}

export async function getErpConnection(
  trx: Knex.Transaction,
  tenantId: string,
  id: string,
): Promise<ErpConnectionRow> {
  const conn = await trx<ErpConnectionRow>('tenant_erp_connections')
    .where({ tenant_id: tenantId, id })
    .first();
  if (!conn) throw AppError.notFound('CONNECTION_NOT_FOUND', `ERP connection ${id} not found`);
  return conn;
}

export async function updateErpConnection(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  id: string,
  input: ErpConnectionUpdateInput,
  actorUserId?: string | null,
): Promise<void> {
  const conn = await getErpConnection(trx, tenantId, id);

  const updates: Record<string, unknown> = { updated_at: trx.fn.now() };
  if (input.label !== undefined) updates['label'] = input.label;
  if (input.baseUrl !== undefined) updates['base_url'] = input.baseUrl;
  if (input.syncScheduleCron !== undefined) updates['sync_schedule_cron'] = input.syncScheduleCron;
  if (input.mapping !== undefined) updates['mapping'] = JSON.stringify(input.mapping);
  if (input.status !== undefined) updates['status'] = input.status;
  if (input.credentialSecret) updates['credential_ref'] = deps.secrets.seal(input.credentialSecret);
  if (input.webhookSecret) updates['webhook_secret_ref'] = deps.secrets.seal(input.webhookSecret);

  await trx('tenant_erp_connections')
    .where({ tenant_id: tenantId, id })
    .update(updates);

  await audit(trx, {
    tenantId,
    actorType: actorUserId ? 'USER' : 'SYSTEM',
    actorId: actorUserId ?? null,
    action: 'erp.connection.updated',
    entityType: 'tenant_erp_connection',
    entityId: id,
    metadata: { label: input.label ?? conn.label },
  });
}

export interface DryRunOutcomeSummary {
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  identityConflicts: number;
}

export interface DryRunResult {
  dryRun: true;
  entity: string;
  total: number;
  summary: DryRunOutcomeSummary;
  sampleRows: Array<{
    externalId: string;
    outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED' | 'IDENTITY_CONFLICT';
    code?: string;
    message?: string;
  }>;
}

export interface LiveSyncResult {
  dryRun: false;
  results: Record<string, RosterBatchResponse>;
}

export async function executeErpSync(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  connectionId: string,
  options: ErpSyncRequestInput,
  actorUserId?: string | null,
): Promise<DryRunResult | LiveSyncResult> {
  const conn = await getErpConnection(trx, tenantId, connectionId);
  if (conn.status === 'DISABLED') {
    throw AppError.forbidden('CONNECTION_DISABLED', 'Cannot sync with a disabled connection');
  }

  const secret = conn.credential_ref ? await deps.secrets.resolve(conn.credential_ref) : undefined;
  const adapter = getErpAdapter(conn.provider);

  const pullData: ErpPullData = await adapter.pull(conn, options.entity, secret, deps.fetch);

  if (options.dryRun) {
    return simulateDryRun(trx, tenantId, conn.provider, options.mode, pullData, options.entity);
  }

  const actor: RosterActor = {
    tenantId,
    provider: conn.provider,
    source: 'ADAPTER',
    connectionId: conn.id,
    actorUserId: actorUserId ?? null,
    sourceLabel: `${conn.label} (${options.entity})`,
  };

  const results: Record<string, RosterBatchResponse> = {};

  if (pullData.academicUnits?.length) {
    results['academicUnits'] = await upsertAcademicUnits(trx, actor, pullData.academicUnits, options.mode);
  }
  if (pullData.courses?.length) {
    results['courses'] = await upsertCourses(trx, actor, pullData.courses, options.mode);
  }
  if (pullData.persons?.length) {
    results['persons'] = await upsertPersons(deps, trx, actor, pullData.persons, options.mode);
  }
  if (pullData.enrollments?.length) {
    results['enrollments'] = await upsertEnrollments(trx, actor, pullData.enrollments, options.mode);
  }

  await trx('tenant_erp_connections')
    .where({ id: conn.id })
    .update({ last_sync_at: trx.fn.now(), updated_at: trx.fn.now() });

  return { dryRun: false, results };
}

async function simulateDryRun(
  trx: Knex.Transaction,
  tenantId: string,
  provider: string,
  mode: 'UPSERT' | 'CREATE_ONLY' | 'UPDATE_ONLY',
  data: ErpPullData,
  requestedEntity: string,
): Promise<DryRunResult> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let rejected = 0;
  let identityConflicts = 0;
  const samples: DryRunResult['sampleRows'] = [];

  if (data.persons?.length) {
    for (const p of data.persons) {
      const identity = await trx('external_identities')
        .where({ tenant_id: tenantId, provider, external_id: p.externalId })
        .first();
      const emailOwner = await trx('users')
        .where({ tenant_id: tenantId, email: p.email })
        .first('id');

      if (identity) {
        if (mode === 'CREATE_ONLY') {
          unchanged++;
          if (samples.length < 20) samples.push({ externalId: p.externalId, outcome: 'UNCHANGED', code: 'EXISTS' });
        } else if (emailOwner && emailOwner.id !== identity.user_id) {
          identityConflicts++;
          if (samples.length < 20) samples.push({ externalId: p.externalId, outcome: 'IDENTITY_CONFLICT', code: 'EMAIL_BELONGS_TO_OTHER_IDENTITY' });
        } else {
          updated++;
          if (samples.length < 20) samples.push({ externalId: p.externalId, outcome: 'UPDATED' });
        }
      } else {
        if (mode === 'UPDATE_ONLY') {
          rejected++;
          if (samples.length < 20) samples.push({ externalId: p.externalId, outcome: 'REJECTED', code: 'NOT_FOUND' });
        } else if (emailOwner) {
          identityConflicts++;
          if (samples.length < 20) samples.push({ externalId: p.externalId, outcome: 'IDENTITY_CONFLICT', code: 'EMAIL_BELONGS_TO_OTHER_IDENTITY' });
        } else {
          created++;
          if (samples.length < 20) samples.push({ externalId: p.externalId, outcome: 'CREATED' });
        }
      }
    }
  }

  if (data.academicUnits?.length) {
    for (const u of data.academicUnits) {
      const table = u.kind === 'DEPARTMENT' ? 'departments' : 'programmes';
      const existing = await trx(table).where({ tenant_id: tenantId, code: u.code }).first();
      if (existing) {
        if (mode === 'CREATE_ONLY') unchanged++;
        else updated++;
        if (samples.length < 20) samples.push({ externalId: u.code, outcome: mode === 'CREATE_ONLY' ? 'UNCHANGED' : 'UPDATED' });
      } else {
        if (mode === 'UPDATE_ONLY') rejected++;
        else created++;
        if (samples.length < 20) samples.push({ externalId: u.code, outcome: mode === 'UPDATE_ONLY' ? 'REJECTED' : 'CREATED' });
      }
    }
  }

  if (data.courses?.length) {
    for (const c of data.courses) {
      const existing = await trx('courses').where({ tenant_id: tenantId, code: c.code }).first();
      if (existing) {
        if (mode === 'CREATE_ONLY') unchanged++;
        else updated++;
        if (samples.length < 20) samples.push({ externalId: c.code, outcome: mode === 'CREATE_ONLY' ? 'UNCHANGED' : 'UPDATED' });
      } else {
        if (mode === 'UPDATE_ONLY') rejected++;
        else created++;
        if (samples.length < 20) samples.push({ externalId: c.code, outcome: mode === 'UPDATE_ONLY' ? 'REJECTED' : 'CREATED' });
      }
    }
  }

  if (data.enrollments?.length) {
    for (const e of data.enrollments) {
      const identity = await trx('external_identities').where({ tenant_id: tenantId, provider, external_id: e.studentExternalId }).first('user_id');
      const course = await trx('courses').where({ tenant_id: tenantId, code: e.courseCode }).first('id');
      if (!identity || !course) {
        rejected++;
        if (samples.length < 20) samples.push({ externalId: e.studentExternalId, outcome: 'REJECTED', code: !identity ? 'STUDENT_NOT_FOUND' : 'COURSE_NOT_FOUND' });
      } else {
        const existing = await trx('course_enrollments').where({ tenant_id: tenantId, user_id: identity.user_id, course_id: course.id, academic_year: e.academicYear, term: e.term }).first();
        if (existing) {
          if (mode === 'CREATE_ONLY') unchanged++;
          else updated++;
          if (samples.length < 20) samples.push({ externalId: e.studentExternalId, outcome: mode === 'CREATE_ONLY' ? 'UNCHANGED' : 'UPDATED' });
        } else {
          if (mode === 'UPDATE_ONLY') rejected++;
          else created++;
          if (samples.length < 20) samples.push({ externalId: e.studentExternalId, outcome: mode === 'UPDATE_ONLY' ? 'REJECTED' : 'CREATED' });
        }
      }
    }
  }

  const total = created + updated + unchanged + rejected + identityConflicts;

  return {
    dryRun: true,
    entity: requestedEntity,
    total,
    summary: { created, updated, unchanged, rejected, identityConflicts },
    sampleRows: samples,
  };
}

