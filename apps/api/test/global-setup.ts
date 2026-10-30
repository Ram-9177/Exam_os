import knex from 'knex';
import { Redis } from 'ioredis';
import { migrationConfig } from '@examos/db';
import { seedPlatform } from '@examos/db/seed';

/**
 * Creates a fresh examos_test database, runs every migration and the platform
 * seed. Tests run against the real PostgreSQL 16 and Redis 7 instances; no mocks.
 */
export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/examos_test';
  const maintenanceUrl = adminUrl.replace(/\/[^/]*$/, '/postgres');
  const dbName = adminUrl.split('/').pop()!.split('?')[0]!;
  const maint = knex({ client: 'pg', connection: maintenanceUrl });
  await maint.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await maint.raw(`CREATE DATABASE "${dbName}"`);
  await maint.destroy();
  const db = knex(migrationConfig(adminUrl));
  await db.migrate.latest();
  await seedPlatform(db);
  await db.destroy();
  const redis = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/9');
  await redis.flushdb();
  redis.disconnect();
}
