import type { Knex } from '@examos/db';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Permission, RoleCode, ScopeType, ApiKeyScope } from '@examos/contracts';
import type { Config } from './config.js';
import type { MailTransportRegistry } from './modules/notifications/transports/index.js';
import type { SecretResolver } from './lib/secrets.js';

export interface TenantContext {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  groupId: string | null;
}

export interface Grant {
  role: RoleCode;
  scopeType: ScopeType;
  scopeId: string | null;
}

export type Principal =
  | { type: 'USER'; userId: string; kind: 'STUDENT' | 'STAFF'; email: string; grants: Grant[]; sessionFamilyId: string }
  | { type: 'API_KEY'; apiKeyId: string; label: string; scopes: ApiKeyScope[]; connectionId: string | null }
  | { type: 'PLATFORM' };

export interface RequestContext {
  requestId: string;
  tenant?: TenantContext;
  principal?: Principal;
  /** set when a user-scoped request was authorised for a specific permission */
  permission?: Permission;
}

export interface Clock {
  now(): Date;
}

export interface AppDeps {
  config: Config;
  db: Knex;
  redis: Redis;
  logger: Logger;
  clock: Clock;
  secrets: SecretResolver;
  mailTransports: MailTransportRegistry;
  /** outbound HTTP for webhooks and the Power Automate transport; injectable for tests */
  fetch: typeof fetch;
  /** sandbox that runs CODE answers; defaults to Judge0 at JUDGE_URL; injectable for tests */
  judge?: import('./modules/evaluation/judge.js').Judge;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx: RequestContext;
  }
}
