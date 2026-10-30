import type { MailTransportKind } from '@examos/contracts';

export interface MailDispatchRow {
  id: string;
  tenant_id: string;
  category: string;
  lane: string;
  to_address: string;
  to_name: string | null;
  subject: string;
  body_html: string;
  body_text: string;
  attempt_count: number;
}

export interface ResolvedMailConfig {
  transportKind: MailTransportKind;
  senderAddress: string;
  senderName: string;
  /** resolved secrets (never persisted) */
  endpoint?: string;
  token?: string;
  settings: Record<string, unknown>;
}

export type TransportOutcome =
  | { outcome: 'ACCEPTED'; providerMessageId?: string }
  /** The provider took the message and will confirm by callback (Power Automate flow). */
  | { outcome: 'PENDING_CALLBACK'; providerMessageId?: string }
  | { outcome: 'RETRY'; error: string }
  | { outcome: 'FAILED'; error: string };

export interface MailTransport {
  readonly kind: MailTransportKind;
  send(dispatch: MailDispatchRow, config: ResolvedMailConfig): Promise<TransportOutcome>;
}

export class MailTransportRegistry {
  private readonly transports = new Map<MailTransportKind, MailTransport>();
  register(t: MailTransport): this {
    this.transports.set(t.kind, t);
    return this;
  }
  get(kind: MailTransportKind): MailTransport {
    const t = this.transports.get(kind);
    if (!t) throw new Error(`no mail transport registered for ${kind}`);
    return t;
  }
}
