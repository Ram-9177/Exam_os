import type { Knex } from '@examos/db';
import type { MailBounceReconcileInput } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { audit } from '../../lib/audit.js';

export interface BounceReconcileResult {
  reconciled: boolean;
  dispatchId?: string;
  toAddress: string;
  previousStatus?: string;
  reason?: string;
}

export async function reconcileBounce(
  _deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  input: MailBounceReconcileInput,
  actorUserId?: string | null,
): Promise<BounceReconcileResult> {
  const normalizedEmail = input.toAddress.trim().toLowerCase();

  // Find candidate dispatch by providerMessageId first, then by to_address
  let query = trx('mail_dispatches').where('tenant_id', tenantId);
  if (input.providerMessageId) {
    query = query.where('provider_message_id', input.providerMessageId);
  } else {
    query = query
      .where('to_address', normalizedEmail)
      .whereIn('status', ['ACCEPTED', 'SENDING', 'QUEUED'])
      .orderBy('created_at', 'desc');
  }

  const dispatch = await query.first('id', 'status', 'to_address', 'subject');
  if (!dispatch) {
    return {
      reconciled: false,
      toAddress: normalizedEmail,
      reason: 'NO_MATCHING_DISPATCH',
    };
  }

  const failureReason = input.reason || input.diagnosticCode || 'Undelivered / Bounced';

  await trx('mail_dispatches')
    .where('id', dispatch.id)
    .update({
      status: 'BOUNCED',
      last_error: failureReason,
      updated_at: trx.fn.now(),
    });

  await audit(trx, {
    tenantId,
    actorType: actorUserId ? 'USER' : 'SYSTEM',
    actorId: actorUserId ?? null,
    action: 'mail.bounced',
    entityType: 'mail_dispatch',
    entityId: dispatch.id,
    metadata: {
      toAddress: dispatch.to_address,
      reason: failureReason,
      diagnosticCode: input.diagnosticCode ?? null,
      providerMessageId: input.providerMessageId ?? null,
      bouncedAt: input.bouncedAt ?? new Date().toISOString(),
    },
  });

  return {
    reconciled: true,
    dispatchId: dispatch.id,
    toAddress: dispatch.to_address,
    previousStatus: dispatch.status,
  };
}

