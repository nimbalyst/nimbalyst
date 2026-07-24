/**
 * Playwright config for extension testing against a running Nimbalyst instance.
 *
 * This config connects to the running app via CDP (Chrome DevTools Protocol)
 * instead of launching a fresh Electron instance. Used by the extension_test_run
 * MCP tool and by extension developers running tests manually.
 *
 * Usage:
 *   npx playwright test --config=playwright-extension.config.ts path/to/test.spec.ts
 */

import { defineConfig } from '@playwright/test';
import * as path from 'path';

const outputDir = path.resolve(__dirname, '../../e2e_test_output/extension-test-results');

export default defineConfig({
  // testDir is set dynamically via CLI args -- the MCP tool passes the test file path directly.
  // We set testDir to the temp directory used by inline scripts so Playwright finds them.
  testDir: process.env.NIMBALYST_EXT_TEST_DIR || path.resolve(__dirname, '../../e2e_test_output/extension-tests-tmp'),
  // Only match *.spec.ts files — avoids picking up vitest *.test.ts files
  // that would crash Playwright when they import from 'vitest'.
  testMatch: '**/*.spec.ts',
  outputDir,
  fullyParallel: false,
  workers: 1,
  retries: 0, // No retries -- agent handles failures directly
  timeout: 30000,
  reporter: [
    ['json', { outputFile: path.join(outputDir, 'results.json') }],
    ['list'], // Human-readable output for stdout
  ],
  use: {
    screenshot: 'only-on-failure',
    trace: 'off', // Keep lightweight for agent loop
  },
});
