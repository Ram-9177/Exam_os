import { withWorkerTx, type Knex } from '@examos/db';
import type { MailTransportKind } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import type { MailDispatchRow, ResolvedMailConfig } from './transports/index.js';

const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 86400];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
/** A Power Automate dispatch with no callback within this window is retried. */
const CALLBACK_TIMEOUT_SECONDS = 15 * 60;

export interface MailWorkerResult {
  claimed: number;
  accepted: number;
  pending: number;
  retried: number;
  failed: number;
}

interface MailConfigRow {
  transport_kind: MailTransportKind;
  sender_address: string;
  sender_name: string;
  endpoint_ref: string | null;
  token_ref: string | null;
  settings: Record<string, unknown>;
}

export async function resolveMailConfig(deps: AppDeps, trx: Knex.Transaction, tenantId: string, category: string): Promise<ResolvedMailConfig> {
  const row = await trx<MailConfigRow>('tenant_mail_configs')
    .where('tenant_id', tenantId)
    .andWhere((qb) => qb.where('category', category).orWhereNull('category'))
    .orderByRaw('category IS NULL ASC')
    .first();
  if (!row) throw new Error(`tenant ${tenantId} has no mail configuration`);
  return {
    transportKind: row.transport_kind,
    senderAddress: row.sender_address,
    senderName: row.sender_name,
    endpoint: row.endpoint_ref ? await deps.secrets.resolve(row.endpoint_ref) : undefined,
    token: row.token_ref ? await deps.secrets.resolve(row.token_ref) : undefined,
    settings: row.settings ?? {},
  };
}

/**
 * One worker pass for one lane. Rows are claimed with FOR UPDATE SKIP LOCKED
 * so several worker processes never send the same dispatch twice; a crashed
 * worker's SENDING rows are reclaimed after the callback timeout.
 */
export async function runMailWorkerOnce(deps: AppDeps, lane: 'TRANSACTIONAL' | 'BULK', batchSize = 50): Promise<MailWorkerResult> {
  const result: MailWorkerResult = { claimed: 0, accepted: 0, pending: 0, retried: 0, failed: 0 };
  const claimed = await withWorkerTx(deps.db, async (trx) => {
    const rows = await trx<MailDispatchRow & { status: string }>('mail_dispatches')
      .where('lane', lane)
      .andWhere((qb) =>
        qb
          .where((q) => q.where('status', 'QUEUED').andWhere('next_attempt_at', '<=', trx.fn.now()))
          .orWhere((q) => q.where('status', 'SENDING').andWhere('locked_at', '<', new Date(deps.clock.now().getTime() - CALLBACK_TIMEOUT_SECONDS * 1000))),
      )
      .orderBy('created_at')
      .limit(batchSize)
      .forUpdate()
      .skipLocked();
    if (rows.length) {
      await trx('mail_dispatches')
        .whereIn(
          'id',
          rows.map((r) => r.id),
        )
        .update({ status: 'SENDING', locked_at: trx.fn.now(), attempt_count: trx.raw('attempt_count + 1'), updated_at: trx.fn.now() });
    }
    return rows;
  });
  result.claimed = claimed.length;

  for (const d of claimed) {
    const attempt = d.attempt_count + 1;
    try {
      const cfg = await withWorkerTx(deps.db, (trx) => resolveMailConfig(deps, trx, d.tenant_id, d.category));
      if (cfg.transportKind === 'capture' && deps.config.isProduction) throw new Error('capture transport is not allowed in production');
      const transport = deps.mailTransports.get(cfg.transportKind);
      const outcome = await transport.send(d, cfg);
      await withWorkerTx(deps.db, async (trx) => {
        const base = { transport_kind: cfg.transportKind, updated_at: trx.fn.now() };
        if (outcome.outcome === 'ACCEPTED') {
          result.accepted++;
          await trx('mail_dispatches').where('id', d.id).update({ ...base, status: 'ACCEPTED', accepted_at: trx.fn.now(), sent_at: trx.fn.now(), provider_message_id: outcome.providerMessageId ?? null, last_error: null });
        } else if (outcome.outcome === 'PENDING_CALLBACK') {
          result.pending++;
          await trx('mail_dispatches').where('id', d.id).update({ ...base, status: 'SENDING', sent_at: trx.fn.now(), provider_message_id: outcome.providerMessageId ?? null, last_error: null });
        } else if (outcome.outcome === 'RETRY' && attempt < MAX_ATTEMPTS) {
          result.retried++;
          const delay = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)]!;
          await trx('mail_dispatches').where('id', d.id).update({ ...base, status: 'QUEUED', locked_at: null, next_attempt_at: new Date(deps.clock.now().getTime() + delay * 1000), last_error: outcome.error });
        } else {
          result.failed++;
          await trx('mail_dispatches').where('id', d.id).update({ ...base, status: 'FAILED', locked_at: null, last_error: outcome.outcome === 'FAILED' || outcome.outcome === 'RETRY' ? outcome.error : 'exhausted retries' });
        }
      });
    } catch (e) {
      result.failed++;
      deps.logger.error({ err: e, dispatchId: d.id }, 'mail dispatch failed');
      await withWorkerTx(deps.db, (trx) =>
        trx('mail_dispatches')
          .where('id', d.id)
          .update({ status: attempt < MAX_ATTEMPTS ? 'QUEUED' : 'FAILED', locked_at: null, next_attempt_at: new Date(deps.clock.now().getTime() + 300_000), last_error: e instanceof Error ? e.message : String(e), updated_at: trx.fn.now() }),
      );
    }
  }
  return result;
}

/** Applies a Power Automate (or any provider) delivery callback. Idempotent. */
export async function applyMailCallback(trx: Knex.Transaction, tenantId: string, cb: { dispatchId: string; outcome: 'ACCEPTED' | 'FAILED'; providerMessageId?: string; error?: string }): Promise<'updated' | 'ignored' | 'not_found'> {
  const row = await trx('mail_dispatches').where({ id: cb.dispatchId, tenant_id: tenantId }).first('status');
  if (!row) return 'not_found';
  if (row.status === 'ACCEPTED' || row.status === 'DELIVERED' || row.status === 'BOUNCED') return 'ignored';
  if (cb.outcome === 'ACCEPTED') {
    await trx('mail_dispatches').where('id', cb.dispatchId).update({ status: 'ACCEPTED', accepted_at: trx.fn.now(), provider_message_id: cb.providerMessageId ?? trx.raw('provider_message_id'), last_error: null, locked_at: null, updated_at: trx.fn.now() });
  } else {
    await trx('mail_dispatches').where('id', cb.dispatchId).update({ status: 'FAILED', last_error: cb.error ?? 'provider reported failure', locked_at: null, updated_at: trx.fn.now() });
  }
  return 'updated';
}
