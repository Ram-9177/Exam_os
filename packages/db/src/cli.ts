import { createAdminDb, dbConfigFromEnv } from './index.js';

const cmd = process.argv[2];
const db = createAdminDb(dbConfigFromEnv());

try {
  if (cmd === 'migrate') {
    const [batch, log] = await db.migrate.latest();
    console.log(`migrated batch ${batch}: ${log.length ? log.join(', ') : 'nothing to do'}`);
  } else if (cmd === 'rollback') {
    const [batch, log] = await db.migrate.rollback();
    console.log(`rolled back batch ${batch}: ${log.join(', ')}`);
  } else if (cmd === 'seed') {
    const { seedPlatform } = await import('./seed.js');
    await seedPlatform(db);
    console.log('seeded');
  } else {
    console.error('usage: cli <migrate|rollback|seed>');
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
