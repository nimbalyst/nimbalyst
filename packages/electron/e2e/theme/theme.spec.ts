import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
  ACTIVE_EDITOR_SELECTOR,
  waitForAppReady
} from '../helpers';
import { openFileFromTree, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';
import path from 'path';
import fs from 'fs/promises';

test.describe.configure({ mode: 'serial' });

// Consolidated theme tests from:
// - theme-switching.spec.ts
// - lexical-list-styling.spec.ts
// - lexical-extension-theme.spec.ts
// - solarized-monaco-editor.spec.ts
// - solarized-table-header.spec.ts

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();

  // Create all test files upfront
  await fs.writeFile(path.join(workspacePath, 'doc-switch.md'), '# Test Document\n\nThis is a test.');
  await fs.writeFile(path.join(workspacePath, 'doc-multi.md'), '# Test Document 2\n\nAnother test.');
  await fs.writeFile(path.join(workspacePath, 'list-test.md'), '# List Test\n\n- Apple\n- Banana\n- Cherry\n');
  await fs.writeFile(path.join(workspacePath, 'bgcolor-test.md'), '# Test Document\n\nThis is test content for theme verification.');
  await fs.writeFile(path.join(workspacePath, 'table-test.md'), '# Test\n\n| Fruit | Color |\n|-------|-------|\n| Apple | Red |');
  await fs.writeFile(path.join(workspacePath, 'test.ts'), `// Test TypeScript file
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const message = greet('World');
console.log(message);
`);

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
    env: { NODE_ENV: 'test' }
  });

  page = await electronApp.firstWindow();

  page.on('console', msg => {
    const text = msg.text();
    console.log(`[BROWSER ${msg.type()}]`, text);
  });

  await waitForAppReady(page);
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

// --- Theme Switching tests ---

test('should switch editor theme immediately when menu item is clicked', async () => {
  // Open theme test file
  await openFileFromTree(page, 'doc-switch.md');
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, { timeout: TEST_TIMEOUTS.medium });

  const editor = page.locator('.nimbalyst-editor').first();
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.medium });

  // Switch to dark theme
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'dark');
    });
  });

  await expect(editor).toHaveAttribute('data-theme', 'dark', { timeout: 2000 });
  await expect(editor).toHaveClass(/dark-theme/, { timeout: 2000 });

  // Switch to light theme
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'light');
    });
  });

  await expect(editor).toHaveAttribute('data-theme', 'light', { timeout: 2000 });
  const lightClasses = await editor.getAttribute('class');
  expect(lightClasses).not.toContain('dark-theme');

  // Switch to crystal dark theme
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'crystal-dark');
    });
  });

  await expect(editor).toHaveAttribute('data-theme', 'crystal-dark', { timeout: 2000 });
  await expect(editor).toHaveClass(/dark-theme/, { timeout: 2000 });
});

test('should switch theme across multiple tabs', async () => {
  // Open second file
  await openFileFromTree(page, 'doc-multi.md');

  // Wait for second tab to appear
  const tabs = page.locator('.file-tabs-container .tab');
  await expect(tabs).toHaveCount(2, { timeout: 2000 });

  // Switch to dark theme
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'dark');
    });
  });

  // Check all editor instances have dark theme
  const editors = page.locator('.nimbalyst-editor');
  const editorCount = await editors.count();

  for (let i = 0; i < editorCount; i++) {
    const editor = editors.nth(i);
    await expect(editor).toHaveClass(/dark-theme/, { timeout: 2000 });
    await expect(editor).toHaveAttribute('data-theme', 'dark', { timeout: 2000 });
  }
});

test('should preserve edited content after theme switch', async () => {
  // Open doc-switch.md explicitly (previous test may have left doc-multi.md active)
  await openFileFromTree(page, 'doc-switch.md');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.medium });

  // Edit the document
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const testContent = 'This is new content added by the test.';
  await page.keyboard.type(testContent);

  await expect(editor).toContainText(testContent, { timeout: 2000 });

  // Wait for autosave
  const testFilePath = path.join(workspacePath, 'doc-switch.md');
  await expect.poll(async () => {
    const content = await fs.readFile(testFilePath, 'utf-8');
    return content.includes(testContent);
  }, { timeout: 5000 }).toBe(true);

  // Switch theme
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'dark');
    });
  });

  const editorRoot = page.locator('.nimbalyst-editor').first();
  await expect(editorRoot).toHaveClass(/dark-theme/, { timeout: 2000 });

  // Verify content preserved
  await expect(editorRoot).toContainText(testContent, { timeout: 2000 });

  const diskContentAfterThemeSwitch = await fs.readFile(testFilePath, 'utf-8');
  expect(diskContentAfterThemeSwitch).toContain(testContent);
});

// --- Lexical List Styling test ---

test('bulleted list should render with nim-ul class and visible bullet markers', async () => {
  await openFileFromTree(page, 'list-test.md');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Check UL element classes
  const ulInfo = await page.evaluate(() => {
    const uls = document.querySelectorAll('ul');
    return Array.from(uls).map(ul => ({
      className: ul.className,
      computedListStyle: window.getComputedStyle(ul).listStyleType,
      computedListStylePosition: window.getComputedStyle(ul).listStylePosition,
      childCount: ul.children.length,
      innerHTML: ul.innerHTML.substring(0, 200),
    }));
  });

  console.log('UL elements found:', JSON.stringify(ulInfo, null, 2));

  const lexicalUl = ulInfo.find(ul => ul.className.includes('nim-ul'));

  expect(lexicalUl, 'Should find a <ul> with nim-ul class').toBeTruthy();
  expect(lexicalUl!.className).toContain('nim-ul');
  expect(lexicalUl!.computedListStyle).toBe('disc');

  // Check list items - scope to the active/visible editor element
  const liInfo = await editor.evaluate((editorEl) => {
    const lis = editorEl.querySelectorAll('li');
    return Array.from(lis).map(li => {
      const styles = window.getComputedStyle(li);
      return {
        className: li.className,
        textContent: li.textContent?.trim(),
        computedDisplay: styles.display,
        listStyleType: styles.listStyleType,
      };
    });
  });

  console.log('LI elements found:', JSON.stringify(liInfo, null, 2));

  expect(liInfo.length).toBeGreaterThanOrEqual(3);
  for (const li of liInfo) {
    expect(li.className).toContain('nim-list-item');
  }

  // List items must NOT have display:flex (suppresses ::marker)
  for (const li of liInfo) {
    expect(li.computedDisplay, `List item "${li.textContent}" should not have display:flex`).not.toBe('flex');
  }
});

// --- Lexical Extension Theme tests ---

// Skip: Extension themes (sample-themes:*) aren't discovered in E2E test environment
test.skip('should apply Solarized Dark theme background to Lexical editor', async () => {
  await openFileFromTree(page, 'bgcolor-test.md');
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, { timeout: TEST_TIMEOUTS.medium });

  const editor = page.locator('.nimbalyst-editor').first();
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.medium });

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'sample-themes:solarized-dark');
    });
  });

  await expect.poll(async () => {
    return await editor.evaluate((el) => window.getComputedStyle(el).backgroundColor);
  }, { timeout: 2000 }).toBe('rgb(0, 43, 54)');
});

test('should apply built-in dark theme correctly', async () => {
  await openFileFromTree(page, 'bgcolor-test.md');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.medium });

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'dark');
    });
  });

  // Built-in dark theme bg is #2d2d2d = rgb(45, 45, 45)
  await expect.poll(async () => {
    return await editor.evaluate((el) => {
      const editor = el.closest('.nimbalyst-editor') || el.querySelector('.nimbalyst-editor') || el;
      return window.getComputedStyle(editor).backgroundColor;
    });
  }, { timeout: 2000 }).toBe('rgb(45, 45, 45)');
});

// Skip: crystal-dark theme isn't discovered in E2E test environment
test.skip('should apply built-in crystal-dark theme correctly', async () => {
  await openFileFromTree(page, 'bgcolor-test.md');
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, { timeout: TEST_TIMEOUTS.medium });

  const editor = page.locator('.nimbalyst-editor').first();
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.medium });

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'crystal-dark');
    });
  });

  await expect.poll(async () => {
    return await editor.evaluate((el) => window.getComputedStyle(el).backgroundColor);
  }, { timeout: 2000 }).toBe('rgb(15, 23, 42)');
});

test('should apply built-in light theme correctly', async () => {
  await openFileFromTree(page, 'bgcolor-test.md');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.medium });

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-change', 'light');
    });
  });

  // Light theme bg is #ffffff = rgb(255, 255, 255)
  await expect.poll(async () => {
    return await editor.evaluate((el) => {
      const editor = el.closest('.nimbalyst-editor') || el.querySelector('.nimbalyst-editor') || el;
      return window.getComputedStyle(editor).backgroundColor;
    });
  }, { timeout: 2000 }).toBe('rgb(255, 255, 255)');
});

// --- Solarized Monaco Editor test ---

// Skip: Extension themes (sample-themes:*) aren't discovered in E2E test environment
test.skip('Monaco editor uses correct theme in Solarized Light', async () => {
  await openFileFromTree(page, 'test.ts');

  await page.waitForSelector('.monaco-editor', { timeout: TEST_TIMEOUTS.medium });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    (window as any).electronAPI.send('set-theme', 'sample-themes:solarized-light', false);
  });

  await page.waitForTimeout(1500);

  const themeAfter = await page.evaluate(() => {
    const editor = document.querySelector('.monaco-editor');
    if (!editor) return { found: false, hasVsDarkTheme: false, bgElementBg: '' };

    const bgElement = document.querySelector('.monaco-editor-background');
    const bgComputed = bgElement ? getComputedStyle(bgElement) : null;

    return {
      found: true,
      hasVsDarkTheme: editor.classList.contains('vs-dark'),
      bgElementBg: bgComputed?.backgroundColor ?? '',
    };
  });

  expect(themeAfter.found).toBe(true);
  expect(themeAfter.hasVsDarkTheme).toBe(false);
  expect(themeAfter.bgElementBg).toBe('rgb(253, 246, 227)');
});

// --- Solarized Table Header test ---

// Skip: Extension themes (sample-themes:*) aren't discovered in E2E test environment
test.skip('table header uses correct background color in Solarized Light', async () => {
  await openFileFromTree(page, 'table-test.md');
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, { timeout: TEST_TIMEOUTS.medium });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    (window as any).electronAPI.send('set-theme', 'sample-themes:solarized-light', false);
  });

  await page.waitForTimeout(1000);

  const tableHeaderInfo = await page.evaluate(() => {
    const headerCells = document.querySelectorAll('.nim-table-cell-header, th, [data-lexical-table-cell-header]');
    const results: Array<{
      tagName: string;
      className: string;
      computedBg: string;
    }> = [];

    headerCells.forEach(cell => {
      const computed = getComputedStyle(cell);
      results.push({
        tagName: cell.tagName,
        className: cell.className,
        computedBg: computed.backgroundColor,
      });
    });

    return {
      headerCellCount: headerCells.length,
      cells: results,
      nimTableHeader: getComputedStyle(document.documentElement).getPropertyValue('--nim-table-header').trim(),
    };
  });

  console.log('Table header info:', JSON.stringify(tableHeaderInfo, null, 2));

  expect(tableHeaderInfo.nimTableHeader).toBe('#eee8d5');

  if (tableHeaderInfo.cells.length > 0) {
    const firstCell = tableHeaderInfo.cells[0];
    expect(firstCell.computedBg).not.toBe('rgb(242, 243, 245)');
  }
});
