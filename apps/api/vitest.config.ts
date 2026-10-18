import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Real mongod startup/download belongs in hooks; a missing binary fails the
    // suite instead of silently skipping database acceptance checks.
    hookTimeout: 120000,
    testTimeout: 15000,
    fileParallelism: false,
  },
});
