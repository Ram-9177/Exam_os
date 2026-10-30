import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
  },
});
