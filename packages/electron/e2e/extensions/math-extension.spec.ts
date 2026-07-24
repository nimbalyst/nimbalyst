import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  launchElectronAppViaCdp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS,
  type CdpElectronApp,
} from '../helpers';
import {
  createTestSession,
  insertAssistantText,
  insertUserPrompt,
  cleanupTestSessions,
} from '../utils/interactivePromptTestHelpers';
import { switchToAgentMode } from '../utils/testHelpers';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

const MATH_EXTENSION_PATH = path.resolve(__dirname, '../../../extensions/math');
const TEST_EXTENSIONS_ROOT = path.join(os.tmpdir(), 'nimbalyst-test-extensions');
const TEST_EXTENSIONS_DIR = path.join(TEST_EXTENSIONS_ROOT, 'extensions');

let electronApp: CdpElectronApp;
let page: Page;
let workspacePath: string;

async function ensureMathExtensionBuilt(): Promise<void> {
  const distPath = path.join(MATH_EXTENSION_PATH, 'dist', 'index.js');
  const distExists = await fs.access(distPath).then(() => true).catch(() => false);
  if (distExists) {
    return;
  }
  execFileSync('npm', ['run', 'build'], {
    cwd: MATH_EXTENSION_PATH,
    stdio: 'inherit',
  });
}

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspacePath, 'transcript-math.md'),
    '# Transcript Math Test\n',
    'utf8'
  );

  await fs.mkdir(TEST_EXTENSIONS_DIR, { recursive: true });

  const linkedExtensionPath = path.join(TEST_EXTENSIONS_DIR, 'math-extension');
  await fs.rm(linkedExtensionPath, { recursive: true, force: true }).catch(() => undefined);
  await fs.symlink(MATH_EXTENSION_PATH, linkedExtensionPath);

  await ensureMathExtensionBuilt();

  electronApp = await launchElectronAppViaCdp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
    env: { PLAYWRIGHT_TEST: 'true' },
  });

  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await switchToAgentMode(page);
  await page.waitForTimeout(1500);
});

test.afterAll(async () => {
  if (page) {
    await cleanupTestSessions(page, workspacePath);
  }
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(TEST_EXTENSIONS_ROOT, { recursive: true, force: true }).catch(() => undefined);
});

test('renders transcript math via the math extension', async () => {
  const sessionId = await createTestSession(page, workspacePath, {
    title: 'Math extension transcript',
  });

  await insertUserPrompt(page, sessionId, 'Render some math.');
  await insertAssistantText(
    page,
    sessionId,
    [
      'Inline math $E=mc^2$ should render.',
      '',
      'And display math should render too:',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
      '$$',
    ].join('\n')
  );

  const sessionItem = page.locator(`#session-list-item-${sessionId}`);
  await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
  await sessionItem.click();

  const assistantBubble = page.locator('.rich-transcript-message.assistant').first();
  await expect(assistantBubble).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });

  await expect(assistantBubble.locator('.katex').first()).toBeVisible({
    timeout: TEST_TIMEOUTS.MEDIUM,
  });
  await expect(assistantBubble.locator('.katex-display')).toHaveCount(1);

  const renderedText = await assistantBubble.locator('.markdown-content').textContent();
  expect(renderedText ?? '').not.toContain('$E=mc^2$');
  expect(renderedText ?? '').not.toContain('$$');
  expect(renderedText ?? '').toContain('should render');
  expect(renderedText ?? '').toContain('display math should render too');
});
