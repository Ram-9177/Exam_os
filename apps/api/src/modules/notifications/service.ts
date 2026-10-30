import type { Knex } from '@examos/db';
import { MAIL_CATEGORY_LANE, type MailCategory } from '@examos/contracts';
import { AppError } from '../../lib/errors.js';

/** Minimal, safe template renderer: {{name}} placeholders, HTML-escaped in the html body. */
export function renderTemplate(template: string, vars: Record<string, string | number>, escapeHtml: boolean): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    const s = String(v);
    return escapeHtml ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : s;
  });
}

export interface EnqueueMailInput {
  tenantId: string;
  category: MailCategory;
  to: { address: string; name?: string | null };
  vars: Record<string, string | number>;
  /** Unique per business event, e.g. `activation:<userId>:<tokenId>`; a repeat is a no-op. */
  dedupeKey: string;
  locale?: string;
}

interface TemplateRow {
  code: string;
  version: number;
  subject: string;
  html: string;
  text: string;
}

/**
 * Writes a mail_dispatches row inside the caller's transaction (transactional
 * outbox, review §6). Resolution order: tenant override → platform default,
 * newest version first.
 */
export async function enqueueMail(trx: Knex.Transaction, input: EnqueueMailInput): Promise<{ dispatchId: string | null; duplicate: boolean }> {
  const locale = input.locale ?? 'en';
  const tpl = (await trx('mail_templates')
    .where({ code: input.category, locale })
    .andWhere((qb) => qb.where('tenant_id', input.tenantId).orWhereNull('tenant_id'))
    .orderByRaw('tenant_id IS NULL ASC, version DESC')
    .first()) as TemplateRow | undefined;
  if (!tpl) throw new AppError(500, 'MAIL_TEMPLATE_MISSING', `No mail template for ${input.category}`);

  const subject = renderTemplate(tpl.subject, input.vars, false);
  const html = renderTemplate(tpl.html, input.vars, true);
  const text = renderTemplate(tpl.text, input.vars, false);

  const inserted = await trx('mail_dispatches')
    .insert({
      tenant_id: input.tenantId,
      category: input.category,
      lane: MAIL_CATEGORY_LANE[input.category],
      template_code: tpl.code,
      template_version: tpl.version,
      to_address: input.to.address.toLowerCase(),
      to_name: input.to.name ?? null,
      subject,
      body_html: html,
      body_text: text,
      dedupe_key: input.dedupeKey,
    })
    .onConflict(['tenant_id', 'dedupe_key'])
    .ignore()
    .returning('id');
  const id = inserted[0]?.id as string | undefined;
  return { dispatchId: id ?? null, duplicate: !id };
}
