/**
 * Editor Type Screenshots
 *
 * Showcase the variety of editors and file types Nimbalyst handles.
 * Each is captured in both dark and light themes.
 */

import { test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchMarketingApp,
  captureScreenshotBothThemes,
  openFile,
  switchToFilesMode,
  pause,
} from '../utils/helpers';
import * as fs from 'fs/promises';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  const result = await launchMarketingApp();
  electronApp = result.app;
  page = result.page;
  workspaceDir = result.workspaceDir;
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('editor-markdown - Rich markdown in Lexical editor', async () => {
  await switchToFilesMode(page);
  await openFile(page, 'README.md');

  // Wait for Lexical to fully render the markdown
  await page.waitForSelector('[contenteditable="true"]', { timeout: 5000 });
  await pause(page, 1000);

  await captureScreenshotBothThemes(electronApp, page, 'editor-markdown');
});

test('editor-code-typescript - TypeScript in Monaco editor', async () => {
  await openFile(page, 'middleware.ts');

  // Wait for Monaco to initialize
  await page.waitForSelector('.monaco-editor', { timeout: 5000 });
  await pause(page, 1000);

  await captureScreenshotBothThemes(electronApp, page, 'editor-code-typescript');
});

test('editor-csv-spreadsheet - CSV in RevoGrid editor', async () => {
  await openFile(page, 'users.csv');

  // Wait for RevoGrid to render
  await page.waitForSelector('revo-grid', { timeout: 5000 });
  await pause(page, 1000);

  await captureScreenshotBothThemes(electronApp, page, 'editor-csv-spreadsheet');
});

test('editor-json - JSON in Monaco editor', async () => {
  await openFile(page, 'config.json');
  await pause(page, 1500); // Let Monaco fully render

  await captureScreenshotBothThemes(electronApp, page, 'editor-json');
});

test('editor-mockup - MockupLM HTML preview', async () => {
  await openFile(page, 'ui-mockup.mockup.html');

  // Wait for the mockup preview to render (custom editor iframe)
  await pause(page, 2000);

  await captureScreenshotBothThemes(electronApp, page, 'editor-mockup');
});

test('editor-datamodel - Prisma schema in DataModelLM', async () => {
  await openFile(page, 'schema.prisma');

  // Wait for DataModelLM to render the visual diagram
  await pause(page, 2000);

  await captureScreenshotBothThemes(electronApp, page, 'editor-datamodel');
});

test('editor-excalidraw - Excalidraw diagram', async () => {
  await openFile(page, 'architecture.excalidraw');

  // Wait for Excalidraw to load
  await pause(page, 3000);

  await captureScreenshotBothThemes(electronApp, page, 'editor-excalidraw');
});

test('editor-api-spec - Markdown API documentation', async () => {
  await openFile(page, 'api-spec.md');
  await pause(page, 1500); // Let Lexical editor fully render

  await captureScreenshotBothThemes(electronApp, page, 'editor-api-spec');
});
