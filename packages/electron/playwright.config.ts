import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Output directory for test artifacts (screenshots, videos, traces)
const testResultsDir = path.resolve(__dirname, '../../e2e_test_output/test-results');
const htmlReportDir = path.resolve(__dirname, '../../e2e_test_output/playwright-report');

export default defineConfig({
  testDir: './e2e',
  outputDir: testResultsDir,
  fullyParallel: false, // Electron tests should run serially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for Electron tests
  reporter: [['html', { outputFolder: htmlReportDir }]],
  timeout: 15000, // 15 seconds for each test (increased to allow for autosave waits)
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: {
        ...devices['Desktop Chrome'],
        // Electron-specific configuration
        channel: 'chrome'
      },
      testMatch: '**/*.spec.ts',
    },
  ],
});