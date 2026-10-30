import { decryptAtRest, encryptAtRest } from './crypto.js';
import { AppError } from './errors.js';

/**
 * A secret reference supplied through a tenant API call may only be ciphertext
 * this service produced (`enc:`). `env:`/`vault:` would let a tenant admin point
 * a mail or SSO transport at the deployment's own secrets (JWT key, database
 * password) and have them sent to an endpoint of their choosing.
 */
export function assertClientSuppliedRef(ref: string | null | undefined, field: string): void {
  if (ref && !ref.startsWith('enc:')) throw AppError.unprocessable('SECRET_REF_NOT_ALLOWED', `${field}: provide the secret value itself; environment and vault references are reserved for platform operators`);
}

/**
 * Secret references stored in configuration rows are resolved here, never
 * read as plaintext columns (review §4). Supported reference forms:
 *   env:NAME      -> process.env.NAME (deployment-managed secret)
 *   enc:<cipher>  -> AES-256-GCM ciphertext under APP_ENCRYPTION_KEY
 *   vault:<path>  -> reserved for the production KMS/vault adapter
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
  /** Produces an `enc:` reference for a value provided through an admin API. */
  seal(value: string): string;
}

export function createSecretResolver(appKey: Buffer, env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return {
    async resolve(ref: string): Promise<string> {
      if (ref.startsWith('env:')) {
        const v = env[ref.slice(4)];
        if (v === undefined) throw new Error(`secret reference ${ref} is not set in the environment`);
        return v;
      }
      if (ref.startsWith('enc:')) return decryptAtRest(appKey, ref.slice(4));
      if (ref.startsWith('vault:')) throw new Error('vault adapter not configured in this deployment');
      throw new Error(`unsupported secret reference scheme: ${ref.split(':')[0]}`);
    },
    seal(value: string): string {
      return `enc:${encryptAtRest(appKey, value)}`;
    },
  };
}
