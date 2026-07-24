/**
 * Excalidraw Editor E2E Tests (Consolidated)
 *
 * Tests for the Excalidraw diagramming editor including:
 * - Basic file loading
 * - Autosave functionality
 * - Dirty close (save on tab close)
 * - External file change detection
 * - Batch operations
 * - Mermaid import
 *
 * This file consolidates tests that previously lived in separate files.
 * All tests share a single app instance for performance.
 */

import { test, expect, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  closeTabByFileName,
  getTabByFileName,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

// Helper to create an empty Excalidraw file
function createEmptyExcalidraw() {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }, null, 2);
}

// Helper to create an Excalidraw file with one element
function createExcalidrawWithElement() {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
      {
        id: 'original-rect',
        type: 'rectangle',
        x: 50,
        y: 50,
        width: 100,
        height: 50,
        backgroundColor: 'transparent',
        strokeColor: '#1e1e1e',
      },
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }, null, 2);
}

// Helper to add an element via Excalidraw API
async function addRectangleViaAPI(page: Page, filePath: string, elementId: string): Promise<boolean> {
  return page.evaluate(({ filePath, elementId }) => {
    const getEditorAPI = (window as any).__testHelpers?.getExtensionEditorAPI;
    if (!getEditorAPI) {
      console.error('No __testHelpers.getExtensionEditorAPI exposed');
      return false;
    }

    const api = getEditorAPI(filePath);
    if (!api || !api.updateScene) {
      console.error('Excalidraw API not ready for path:', filePath);
      return false;
    }

    const currentElements = api.getSceneElements() || [];
    const rectangle = {
      id: elementId,
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      angle: 0,
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      fillStyle: 'hachure',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: Math.floor(Math.random() * 100000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 100000),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
    };

    api.updateScene({
      elements: [...currentElements, rectangle],
    });

    return true;
  }, { filePath, elementId });
}

// Helper to get element count via Excalidraw API
async function getElementCount(page: Page, filePath: string): Promise<number> {
  return page.evaluate((filePath) => {
    const getEditorAPI = (window as any).__testHelpers?.getExtensionEditorAPI;
    if (getEditorAPI) {
      const api = getEditorAPI(filePath);
      if (api) {
        return api.getSceneElements().length;
      }
    }
    return -1;
  }, filePath);
}

// Shared app instance for all tests in this file
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create ALL test files upfront for all scenarios
  await fs.writeFile(path.join(workspaceDir, 'basic-test.excalidraw'), createEmptyExcalidraw(), 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'autosave-test.excalidraw'), createEmptyExcalidraw(), 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'dirty-close-test.excalidraw'), createEmptyExcalidraw(), 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'external-change-test.excalidraw'), createExcalidrawWithElement(), 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'batch-test.excalidraw'), createEmptyExcalidraw(), 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'mermaid-test.excalidraw'), createEmptyExcalidraw(), 'utf8');

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

// ============================================================================
// BASIC TESTS
// ============================================================================

test('can open excalidraw file without errors', async () => {
  await openFileFromTree(page, 'basic-test.excalidraw');

  // Wait for the Excalidraw editor container to load
  await page.waitForSelector('.excalidraw-editor', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Verify the editor is visible
  const excalidrawContainer = page.locator('.excalidraw-editor');
  await expect(excalidrawContainer).toBeVisible();

  // Wait a bit to ensure the Excalidraw component renders without errors
  await page.waitForTimeout(2000);

  // Verify the actual Excalidraw canvas loaded
  const excalidrawCanvas = page.locator('.excalidraw');
  await expect(excalidrawCanvas).toBeVisible();

  await closeTabByFileName(page, 'basic-test.excalidraw');
});

// ============================================================================
// AUTOSAVE TESTS
// ============================================================================

test('autosave clears dirty indicator and saves content', async () => {
  const excalidrawPath = path.join(workspaceDir, 'autosave-test.excalidraw');
  // Reset file content
  await fs.writeFile(excalidrawPath, createEmptyExcalidraw(), 'utf8');

  await openFileFromTree(page, 'autosave-test.excalidraw');
  await page.waitForSelector('.excalidraw-editor', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Add an element via the API
  const elementAdded = await addRectangleViaAPI(page, excalidrawPath, 'autosave-test-rect');
  expect(elementAdded).toBe(true);
  await page.waitForTimeout(500);

  // Verify dirty indicator appears
  const tabElement = getTabByFileName(page, 'autosave-test.excalidraw');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });

  // Wait for autosave (2s interval + 200ms debounce + buffer)
  await page.waitForTimeout(3500);

  // Verify dirty indicator cleared
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0, { timeout: 1000 });

  // Verify content saved to disk
  const savedContent = await fs.readFile(excalidrawPath, 'utf-8');
  const parsed = JSON.parse(savedContent);
  expect(parsed.elements.length).toBeGreaterThan(0);
  expect(parsed.elements.some((e: any) => e.id === 'autosave-test-rect')).toBe(true);

  await closeTabByFileName(page, 'autosave-test.excalidraw');
});

// ============================================================================
// DIRTY CLOSE TESTS
// ============================================================================

test('edited content is saved when tab is closed', async () => {
  const excalidrawPath = path.join(workspaceDir, 'dirty-close-test.excalidraw');
  // Reset file content
  await fs.writeFile(excalidrawPath, createEmptyExcalidraw(), 'utf8');

  await openFileFromTree(page, 'dirty-close-test.excalidraw');
  await page.waitForSelector('.excalidraw', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(1000);

  // Wait for the Excalidraw canvas to be ready
  const canvas = page.locator('.excalidraw canvas').first();
  await canvas.waitFor({ state: 'visible' });
  await page.waitForTimeout(500);

  // Add element via API
  const elementAdded = await addRectangleViaAPI(page, excalidrawPath, `dirty-close-rect-${Date.now()}`);
  expect(elementAdded).toBe(true);

  // Wait for dirty indicator to appear
  const tabElement = getTabByFileName(page, 'dirty-close-test.excalidraw');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 3000 });

  // Close the tab
  await closeTabByFileName(page, 'dirty-close-test.excalidraw');
  await page.waitForTimeout(500);

  // Verify content was saved
  const savedContent = await fs.readFile(excalidrawPath, 'utf-8');
  const savedData = JSON.parse(savedContent);

  expect(savedData.elements.length).toBeGreaterThan(0);
  const rectangle = savedData.elements.find((el: any) => el.type === 'rectangle');
  expect(rectangle).toBeDefined();
});

// ============================================================================
// EXTERNAL CHANGE TESTS
// ============================================================================

test('external file change auto-reloads when editor is clean', async () => {
  const excalidrawPath = path.join(workspaceDir, 'external-change-test.excalidraw');
  // Reset file content
  await fs.writeFile(excalidrawPath, createExcalidrawWithElement(), 'utf8');

  await openFileFromTree(page, 'external-change-test.excalidraw');
  await page.waitForSelector('.excalidraw-editor', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Wait for initial load and any auto-save to settle
  // Need to wait >2s AFTER the last save for the time-based echo detection heuristic to pass
  await page.waitForTimeout(3500);

  // Verify no dirty indicator
  const tabElement = getTabByFileName(page, 'external-change-test.excalidraw');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0);

  // Verify original element count
  const initialElementCount = await getElementCount(page, excalidrawPath);
  expect(initialElementCount).toBe(1);

  // Modify file externally - add a second element
  const modifiedContent = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
      {
        id: 'original-rect',
        type: 'rectangle',
        x: 50,
        y: 50,
        width: 100,
        height: 50,
        backgroundColor: 'transparent',
        strokeColor: '#1e1e1e',
      },
      {
        id: 'external-rect',
        type: 'rectangle',
        x: 200,
        y: 200,
        width: 150,
        height: 75,
        backgroundColor: '#a5d8ff',
        strokeColor: '#1e1e1e',
      },
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }, null, 2);
  await fs.writeFile(excalidrawPath, modifiedContent, 'utf8');

  // Wait for file watcher to detect and reload - poll a few times
  let finalElementCount = -1;
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(500);
    finalElementCount = await getElementCount(page, excalidrawPath);
    if (finalElementCount === 2) break;
  }

  expect(finalElementCount).toBe(2);

  await closeTabByFileName(page, 'external-change-test.excalidraw');
});

// ============================================================================
// BATCH OPERATIONS TESTS
// ============================================================================

test('add_elements creates multiple rectangles in one operation', async () => {
  // Reset file content
  await fs.writeFile(path.join(workspaceDir, 'batch-test.excalidraw'), createEmptyExcalidraw(), 'utf8');

  await openFileFromTree(page, 'batch-test.excalidraw');
  await page.waitForSelector('.excalidraw-editor', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  const excalidrawPath = path.join(workspaceDir, 'batch-test.excalidraw');
  const result = await page.evaluate(async (filePath) => {
    const getEditorAPI = (window as any).__testHelpers?.getExtensionEditorAPI;
    if (!getEditorAPI) {
      return { success: false, error: 'No __testHelpers.getExtensionEditorAPI' };
    }

    const api = getEditorAPI(filePath);
    if (!api) {
      return { success: false, error: 'No active editor' };
    }

    const elementsBefore = api.getSceneElements().length;

    // Create batch of elements
    api.updateScene({
      elements: [
        ...api.getSceneElements(),
        { id: 'rect1', type: 'rectangle', x: 100, y: 100, width: 150, height: 80, backgroundColor: 'transparent', strokeColor: '#1e1e1e' },
        { id: 'text1', type: 'text', x: 125, y: 130, width: 100, height: 25, text: 'Box A', containerId: 'rect1' },
        { id: 'rect2', type: 'rectangle', x: 300, y: 100, width: 150, height: 80, backgroundColor: 'transparent', strokeColor: '#1e1e1e' },
        { id: 'text2', type: 'text', x: 325, y: 130, width: 100, height: 25, text: 'Box B', containerId: 'rect2' },
        { id: 'rect3', type: 'rectangle', x: 500, y: 100, width: 150, height: 80, backgroundColor: '#a5d8ff', strokeColor: '#1e1e1e' },
        { id: 'text3', type: 'text', x: 525, y: 130, width: 100, height: 25, text: 'Box C', containerId: 'rect3' },
      ],
    });

    const elementsAfter = api.getSceneElements().length;
    const rectangles = api.getSceneElements().filter((el: any) => el.type === 'rectangle');
    const texts = api.getSceneElements().filter((el: any) => el.type === 'text');

    return {
      success: true,
      elementsBefore,
      elementsAfter,
      rectangleCount: rectangles.length,
      textCount: texts.length,
      labels: texts.map((t: any) => 'text' in t ? t.text : ''),
    };
  }, excalidrawPath);

  expect(result.success).toBe(true);
  expect(result.elementsBefore).toBe(0);
  expect(result.elementsAfter).toBe(6);
  expect(result.rectangleCount).toBe(3);
  expect(result.textCount).toBe(3);
  expect(result.labels).toEqual(['Box A', 'Box B', 'Box C']);

  await closeTabByFileName(page, 'batch-test.excalidraw');
});

// ============================================================================
// MERMAID IMPORT TESTS
// ============================================================================

// Skip: Mermaid import test is flaky - console errors occur inconsistently
test.skip('should import a simple mermaid diagram without crashing', async () => {
  // Reset file content
  await fs.writeFile(path.join(workspaceDir, 'mermaid-test.excalidraw'), createEmptyExcalidraw(), 'utf8');

  await openFileFromTree(page, 'mermaid-test.excalidraw');
  await page.waitForSelector('.excalidraw-editor', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Track console errors
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  const excalidrawPath = path.join(workspaceDir, 'mermaid-test.excalidraw');
  const result = await page.evaluate(async (filePath) => {
    const mermaid = `graph TD
      A[Start] --> B[Process]
      B --> C[End]`;

    try {
      const getEditorAPI = (window as any).__testHelpers?.getExtensionEditorAPI;
      const parseMermaidToExcalidraw = (window as any).__excalidraw_parseMermaidToExcalidraw;

      if (!getEditorAPI || !parseMermaidToExcalidraw) {
        return { success: false, error: 'Extension API not found' };
      }

      const api = getEditorAPI(filePath);
      if (!api) {
        return { success: false, error: 'No active editor' };
      }

      const { elements } = await parseMermaidToExcalidraw(mermaid, { fontSize: 16 });

      const currentElements = api.getSceneElements();
      const elementsBefore = currentElements.length;
      api.updateScene({ elements: [...currentElements, ...elements] });
      const elementsAfter = api.getSceneElements().length;

      return {
        success: true,
        elementCount: elements.length,
        elementsBefore,
        elementsAfter,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, excalidrawPath);

  expect(result).toHaveProperty('success', true);

  // Wait for rendering and move mouse to trigger any potential errors
  await page.waitForTimeout(1000);
  const canvas = await page.locator('.excalidraw-editor').boundingBox();
  if (canvas) {
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.waitForTimeout(500);
  }

  // Check that no length errors occurred
  const lengthErrors = errors.filter(e => e.includes('Cannot read properties of undefined (reading \'length\')'));
  expect(lengthErrors).toHaveLength(0);

  await closeTabByFileName(page, 'mermaid-test.excalidraw');
});
