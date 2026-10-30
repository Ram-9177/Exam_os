import type { Knex } from '@examos/db';
import { canonicalJson, sha256Hex } from './crypto.js';

export interface AuditInput {
  tenantId: string | null;
  actorType: 'USER' | 'API_KEY' | 'SYSTEM' | 'PLATFORM';
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit log with a per-tenant hash chain (spec §8, §16). The chain
 * is advisory tamper evidence inside the database; the out-of-band signed
 * manifest export (Gate F) is what makes it provable against a privileged
 * insider. Must be called inside the same transaction as the change it records.
 */
export async function audit(trx: Knex.Transaction, input: AuditInput): Promise<string> {
  const prev = await trx('audit_events')
    .modify((qb) => (input.tenantId ? qb.where('tenant_id', input.tenantId) : qb.whereNull('tenant_id')))
    .orderBy('seq', 'desc')
    .first('hash');
  const prevHash: string | null = prev?.hash ?? null;
  const createdAt = new Date();
  const body = {
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata ?? {},
    createdAt: createdAt.toISOString(),
    prevHash,
  };
  const hash = sha256Hex(canonicalJson(body));
  const [row] = await trx('audit_events')
    .insert({
      tenant_id: input.tenantId,
      actor_type: input.actorType,
      actor_id: input.actorId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      request_id: input.requestId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      prev_hash: prevHash,
      hash,
      created_at: createdAt,
    })
    .returning('id');
  return row.id as string;
}

/** Hash-chained per-attempt activity timeline (spec §8). */
export async function logAttemptEvent(
  trx: Knex.Transaction,
  input: { tenantId: string; attemptId: string; eventType: string; actor: string; questionId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  const prev = await trx('attempt_event_log').where('attempt_id', input.attemptId).orderBy('seq', 'desc').first('hash');
  const prevHash: string | null = prev?.hash ?? null;
  const at = new Date();
  const hash = sha256Hex(canonicalJson({ ...input, at: at.toISOString(), prevHash }));
  await trx('attempt_event_log').insert({
    tenant_id: input.tenantId,
    attempt_id: input.attemptId,
    event_type: input.eventType,
    actor: input.actor,
    question_id: input.questionId ?? null,
    metadata: JSON.stringify(input.metadata ?? {}),
    prev_hash: prevHash,
    hash,
    server_received_at: at,
  });
}
