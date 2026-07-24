import { defineConfig } from '@playwright/test';
import * as path from 'path';

/**
 * Playwright config for marketing screenshot & video capture.
 * Completely separate from E2E test config.
 *
 * Usage:
 *   npx playwright test --config=marketing/playwright.marketing.config.ts
 *   npx playwright test --config=marketing/playwright.marketing.config.ts --grep="hero"
 */

const screenshotDir = path.resolve(__dirname, 'screenshots');
const videoDir = path.resolve(__dirname, 'videos');

export default defineConfig({
  testDir: path.resolve(__dirname, 'specs'),
  outputDir: path.resolve(__dirname, 'output'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60000, // Marketing specs can take longer (videos, animations)
  use: {
    screenshot: 'off',
    video: 'off', // We control video recording manually per-spec
    trace: 'off',
  },
  projects: [
    {
      name: 'marketing',
      testMatch: '**/*.spec.ts',
    },
  ],
});

export { screenshotDir, videoDir };
