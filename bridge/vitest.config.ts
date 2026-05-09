import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
  },
});
