process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://examos_app:examos_app@127.0.0.1:5432/examos_test';
process.env['DATABASE_ADMIN_URL'] = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/examos_test';
process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/9';
process.env['PLATFORM_BOOTSTRAP_KEY'] = 'test-platform-bootstrap-key-0123456789';
process.env['LOG_LEVEL'] = process.env['DEBUG_LOG_LEVEL'] ?? 'silent';
process.env['EXAMOS_ALLOW_HTTP_WEBHOOKS'] = '1';
process.env['ADMISSION_GRANT_TTL_SECONDS'] = '120';
