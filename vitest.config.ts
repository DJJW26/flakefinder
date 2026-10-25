import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/parsers/**', 'src/store/**'],
      thresholds: { lines: 85, functions: 80, branches: 80, statements: 85 },
    },
  },
});
