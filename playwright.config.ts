import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const electronE2EDir = path.join(__dirname, 'packages/electron/e2e');

if (!process.env.TS_NODE_PROJECT) {
  process.env.TS_NODE_PROJECT = path.join(__dirname, 'tsconfig.playwright.json');
}

export default defineConfig({
  testDir: electronE2EDir,
  fullyParallel: false,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'playwright-report/electron-e2e.xml' }]]
    : [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'electron',
      testDir: electronE2EDir,
    },
  ],
});
