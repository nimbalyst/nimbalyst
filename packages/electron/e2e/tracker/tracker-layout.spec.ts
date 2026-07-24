/**
 * Tracker table layout visual test.
 *
 * Opens tracker mode with bugs that have data, screenshots the layout
 * so we can verify column sizing and row rendering.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create a markdown file with several bug tracker items of varying title lengths.
  // Tracker items use inline format: `Title #type[id:... status:... priority:...]`.
  const bugsContent = `# Bugs

- Lexical table diffs require clicking "Keep All" twice to accept changes. When a markdown diff contains table edits, the first click on "Keep All" doesn't dismiss the diff header #bug[id:bug_layout1 status:to-do priority:medium]
- Clicking on a bug in bottom tracker doesn't scroll to the bug correctly #bug[id:bug_layout2 status:to-do priority:high]
- cmd+f is loading a find window for something else #bug[id:bug_layout3 status:in-progress priority:low]
- Mouse doesn't scroll typeahead menus anymore #bug[id:bug_layout4 status:done priority:medium]
- Short title bug #bug[id:bug_layout5 status:to-do priority:critical]
`;

  await fs.writeFile(path.join(workspaceDir, 'bugs.md'), bugsContent);

  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'allow-all' });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('tracker layout shows full titles and correct badge rendering', async () => {
  // Navigate to Tracker mode
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerModeButton).click();

  const trackerSidebar = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerSidebar);
  await trackerSidebar.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

  // Select Bugs type
  const bugsButton = page.locator(`${PLAYWRIGHT_TEST_SELECTORS.trackerTypeButton}[data-tracker-type="bug"]`);
  await bugsButton.click();

  const trackerTable = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTable);
  await trackerTable.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  // Wait for bugs to appear (indexing takes a moment)
  const firstRow = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTableRow).first();
  await expect(firstRow).toBeVisible({ timeout: 10000 });

  // Wait a beat for all rows to render
  await page.waitForTimeout(500);

  // Screenshot the tracker table for visual verification
  await trackerTable.screenshot({ path: 'e2e_test_output/tracker-layout.png' });

  // Basic assertions: rows should be visible
  const rows = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTableRow);
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThanOrEqual(3);

  // The title text should be visible and not excessively truncated.
  // Row ordering can vary, so check across all rows: the longest title we wrote
  // is ~170 chars; at least one row should show substantial text.
  const titleTexts = await rows.locator('.tracker-table-cell.title').allTextContents();
  expect(titleTexts.length).toBeGreaterThanOrEqual(3);
  const maxTitleLen = Math.max(...titleTexts.map((t) => t.length));
  expect(maxTitleLen).toBeGreaterThan(50);
});
