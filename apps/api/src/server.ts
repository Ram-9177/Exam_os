import { createApp } from './app.js';
import { buildDeps } from './deps.js';

const deps = buildDeps();
// Tenant isolation rests on row-level security, which a superuser or a BYPASSRLS role silently skips.
// Production refuses to start with such a DATABASE_URL; development only warns.
const role = (await deps.db.raw('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0] as { rolsuper: boolean; rolbypassrls: boolean } | undefined;
if (role && (role.rolsuper || role.rolbypassrls)) {
  const msg = 'DATABASE_URL connects as a superuser or BYPASSRLS role: row-level security would not apply. Use the examos_app role.';
  if (deps.config.isProduction) {
    deps.logger.fatal(msg);
    process.exit(1);
  }
  deps.logger.warn(msg);
}
const { app } = await createApp(deps);
const server = app.listen(deps.config.PORT, () => deps.logger.info({ port: deps.config.PORT, env: deps.config.NODE_ENV }, 'ExamOS API listening'));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    deps.logger.info({ sig }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
