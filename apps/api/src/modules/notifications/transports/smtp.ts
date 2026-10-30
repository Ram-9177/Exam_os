import nodemailer, { type Transporter } from 'nodemailer';
import type { MailDispatchRow, MailTransport, ResolvedMailConfig, TransportOutcome } from './index.js';

/**
 * Nodemailer transports (the mandated library) used as fallbacks:
 *  - smtp-oauth2: XOAUTH2 client submission to smtp.office365.com / Google;
 *    requires settings.user, settings.clientId, settings.clientSecret (via token),
 *    settings.refreshToken or an access token minted by the caller. Basic
 *    username/password is deliberately not offered (review §6).
 *  - smtp-relay: IP-authenticated connector relay (port 25), internal
 *    recipients only by default.
 */
export class SmtpOAuth2Transport implements MailTransport {
  readonly kind = 'smtp-oauth2' as const;
  private cache = new Map<string, Transporter>();

  private transporter(cfg: ResolvedMailConfig): Transporter {
    const host = String(cfg.settings['host'] ?? 'smtp.office365.com');
    const port = Number(cfg.settings['port'] ?? 587);
    const user = String(cfg.settings['user'] ?? cfg.senderAddress);
    const key = `${host}:${port}:${user}`;
    let t = this.cache.get(key);
    if (!t) {
      t = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        requireTLS: true,
        auth: {
          type: 'OAuth2',
          user,
          clientId: String(cfg.settings['clientId'] ?? ''),
          clientSecret: cfg.token ?? '',
          refreshToken: typeof cfg.settings['refreshToken'] === 'string' ? (cfg.settings['refreshToken'] as string) : undefined,
          accessToken: typeof cfg.settings['accessToken'] === 'string' ? (cfg.settings['accessToken'] as string) : undefined,
          accessUrl: typeof cfg.settings['accessUrl'] === 'string' ? (cfg.settings['accessUrl'] as string) : undefined,
        },
      });
      this.cache.set(key, t);
    }
    return t;
  }

  async send(d: MailDispatchRow, cfg: ResolvedMailConfig): Promise<TransportOutcome> {
    return sendWithNodemailer(this.transporter(cfg), d, cfg);
  }
}

export class SmtpRelayTransport implements MailTransport {
  readonly kind = 'smtp-relay' as const;
  private cache = new Map<string, Transporter>();

  async send(d: MailDispatchRow, cfg: ResolvedMailConfig): Promise<TransportOutcome> {
    const host = String(cfg.settings['host'] ?? '');
    if (!host) return { outcome: 'FAILED', error: 'smtp-relay transport has no host configured' };
    const port = Number(cfg.settings['port'] ?? 25);
    const key = `${host}:${port}`;
    let t = this.cache.get(key);
    if (!t) {
      t = nodemailer.createTransport({ host, port, secure: false, requireTLS: cfg.settings['requireTls'] !== false });
      this.cache.set(key, t);
    }
    return sendWithNodemailer(t, d, cfg);
  }
}

async function sendWithNodemailer(t: Transporter, d: MailDispatchRow, cfg: ResolvedMailConfig): Promise<TransportOutcome> {
  try {
    const info = await t.sendMail({
      from: { name: cfg.senderName, address: cfg.senderAddress },
      to: d.to_name ? { name: d.to_name, address: d.to_address } : d.to_address,
      subject: d.subject,
      text: d.body_text,
      html: d.body_html,
      headers: { 'X-ExamOS-Dispatch': d.id },
    });
    return { outcome: 'ACCEPTED', providerMessageId: info.messageId };
  } catch (e) {
    const err = e as { responseCode?: number; message?: string };
    const code = err.responseCode ?? 0;
    // 5xx SMTP codes are permanent failures; everything else is retried with backoff.
    if (code >= 500 && code < 600) return { outcome: 'FAILED', error: `${code} ${err.message ?? ''}`.trim() };
    return { outcome: 'RETRY', error: err.message ?? 'smtp error' };
  }
}
