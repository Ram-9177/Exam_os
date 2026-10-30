import { createApp } from './app.js';
import { buildDeps } from './deps.js';

const deps = buildDeps();
const { app } = await createApp(deps);
const server = app.listen(deps.config.PORT, () => deps.logger.info({ port: deps.config.PORT, env: deps.config.NODE_ENV }, 'ExamOS API listening'));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    deps.logger.info({ sig }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
