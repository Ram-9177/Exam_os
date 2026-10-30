import { z } from 'zod';
import { generateKeyPairSync } from 'node:crypto';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://examos_app:examos_app@127.0.0.1:5432/examos_dev'),
  DATABASE_ADMIN_URL: z.string().default('postgres://postgres:postgres@127.0.0.1:5432/examos_dev'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379/0'),
  /** Connections per API process; sized with PgBouncer in mind (docs/capacity-and-budget.md). */
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
  /** Waiting longer than this for a pooled connection fails the request with 503 DB_BUSY (retryable) instead of queueing. */
  DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  JWT_ISSUER: z.string().default('https://examos.local'),
  JWT_AUDIENCE: z.string().default('examos-api'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_TTL_SECONDS: z.coerce.number().int().min(600).default(60 * 60 * 12),
  JWT_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_PUBLIC_KEY_PEM: z.string().optional(),
  JWT_KID: z.string().default('examos-k1'),
  /** 32-byte hex key for AES-256-GCM at-rest encryption of webhook secrets etc. */
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Bootstrap credential for POST /platform/tenants; replace with platform admin accounts before production. */
  PLATFORM_BOOTSTRAP_KEY: z.string().min(24).optional(),
  PUBLIC_PORTAL_URL: z.string().url().default('https://exam.smru.edu.in'),
  ACTIVATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(48),
  ADMISSION_GRANT_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  LOG_LEVEL: z.string().default('info'),
  EXAMOS_ALLOW_HTTP_WEBHOOKS: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  appEncryptionKey: Buffer;
  isProduction: boolean;
}

export function loadConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  const isProduction = env.NODE_ENV === 'production';

  let jwtPrivateKeyPem = env.JWT_PRIVATE_KEY_PEM;
  let jwtPublicKeyPem = env.JWT_PUBLIC_KEY_PEM;
  if (!jwtPrivateKeyPem || !jwtPublicKeyPem) {
    if (isProduction) throw new Error('JWT_PRIVATE_KEY_PEM and JWT_PUBLIC_KEY_PEM are required in production');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    jwtPrivateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    jwtPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  let appEncryptionKey: Buffer;
  if (env.APP_ENCRYPTION_KEY) {
    appEncryptionKey = Buffer.from(env.APP_ENCRYPTION_KEY, 'hex');
  } else {
    if (isProduction) throw new Error('APP_ENCRYPTION_KEY is required in production');
    appEncryptionKey = Buffer.from('0f'.repeat(32), 'hex');
  }

  return { ...env, jwtPrivateKeyPem, jwtPublicKeyPem, appEncryptionKey, isProduction };
}
