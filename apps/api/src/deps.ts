import { Redis } from 'ioredis';
import pino from 'pino';
import { createDb } from '@examos/db';
import { loadConfig, type Config } from './config.js';
import type { AppDeps } from './types.js';
import { createSecretResolver } from './lib/secrets.js';
import { MailTransportRegistry } from './modules/notifications/transports/index.js';
import { PowerAutomateTransport } from './modules/notifications/transports/power-automate.js';
import { SmtpOAuth2Transport, SmtpRelayTransport } from './modules/notifications/transports/smtp.js';
import { GraphTransport } from './modules/notifications/transports/graph.js';
import { CaptureTransport } from './modules/notifications/transports/capture.js';
import { AcsEmailTransport } from './modules/notifications/transports/acs-email.js';
import { SesTransport } from './modules/notifications/transports/ses.js';

export interface BuildDepsOptions {
  config?: Config;
  fetchImpl?: typeof fetch;
  capture?: CaptureTransport;
}

export function buildDeps(opts: BuildDepsOptions = {}): AppDeps {
  const config = opts.config ?? loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers["x-api-key"]'] });
  const db = createDb({ connectionString: config.DATABASE_URL, adminConnectionString: config.DATABASE_ADMIN_URL, poolMax: config.DB_POOL_MAX, acquireTimeoutMs: config.DB_ACQUIRE_TIMEOUT_MS });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const mailTransports = new MailTransportRegistry()
    .register(new PowerAutomateTransport(fetchImpl))
    .register(new SmtpOAuth2Transport())
    .register(new SmtpRelayTransport())
    .register(new GraphTransport(fetchImpl))
    .register(new AcsEmailTransport(fetchImpl))
    .register(new SesTransport(fetchImpl))
    .register(opts.capture ?? new CaptureTransport());
  return { config, db, redis, logger, clock: { now: () => new Date() }, secrets: createSecretResolver(config.appEncryptionKey), mailTransports, fetch: fetchImpl };
}

export async function closeDeps(deps: AppDeps): Promise<void> {
  await deps.db.destroy();
  deps.redis.disconnect();
}
