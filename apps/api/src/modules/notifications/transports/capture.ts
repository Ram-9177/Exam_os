import type { MailDispatchRow, MailTransport, ResolvedMailConfig, TransportOutcome } from './index.js';

/**
 * Capture transport for development and automated tests: records what would
 * have been sent and reports ACCEPTED. It is not selectable in production
 * (the tenant mail config validator refuses it when NODE_ENV=production).
 */
export class CaptureTransport implements MailTransport {
  readonly kind = 'capture' as const;
  readonly sent: Array<{ dispatch: MailDispatchRow; config: ResolvedMailConfig }> = [];
  async send(d: MailDispatchRow, cfg: ResolvedMailConfig): Promise<TransportOutcome> {
    this.sent.push({ dispatch: d, config: cfg });
    return { outcome: 'ACCEPTED', providerMessageId: `capture-${d.id}` };
  }
}
