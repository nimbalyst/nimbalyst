/**
 * Scale measurements for the spreadsheet (plan Phase 8). Not part of the
 * default suite (its files are outside every `__tests__` include). Run from the
 * repo root:
 *
 *   pnpm vitest run --config packages/extensions/csv-spreadsheet/perf/vitest.perf.config.ts
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: __dirname,
    include: ['**/*.perf.ts'],
    environment: 'node',
    testTimeout: 600_000,
  },
});
