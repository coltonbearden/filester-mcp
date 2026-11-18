import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/slow.test.ts', 'test/live.test.ts'],
          testTimeout: 30_000,
        },
      },
      { test: { name: 'slow', include: ['test/slow.test.ts'], testTimeout: 900_000 } },
      {
        test: {
          name: 'live',
          include: ['test/live.test.ts'],
          testTimeout: 3_600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
