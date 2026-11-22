/**
 * Run Manager (built-in, developer mode): a run target is a named command
 * that runs in a terminal tab Nimbalyst owns.
 *
 * One workflow against a real process: add a target for a tiny Node HTTP
 * server, start it from the Runs panel, see the gutter badge turn green, read
 * its output the way an agent's `run_logs` does, open its log tab, stop it
 * and find the port free, then start it again and turn the extension off,
 * which must stop it too.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { launchElectronApp, createTempWorkspace, waitForAppReady } from '../helpers';
import { PLAYWRIGHT_TEST_SELECTORS, dismissAPIKeyDialog, waitForWorkspaceReady } from '../utils/testHelpers';
import { trustWorkspace } from '../utils/permissionTestHelpers';

const EXTENSION_ID = 'com.nimbalyst.run';

/** A port nothing is listening on right now. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function httpGet(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

test.describe('Run Manager', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;
  let port: number;

  test.beforeEach(async () => {
    workspaceDir = await createTempWorkspace();
    port = await findFreePort();
    await fs.writeFile(
      path.join(workspaceDir, 'server.js'),
      [
        "const http = require('http');",
        'const port = Number(process.argv[2]);',
        'http',
        "  .createServer((req, res) => { console.log('request ' + req.url); res.end('run-manager-e2e'); })",
        "  .listen(port, '127.0.0.1', () => console.log('listening on ' + port));",
        '',
      ].join('\n'),
      'utf8'
    );

    electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'allow-all' });
    page = await electronApp.firstWindow();
    await waitForAppReady(page);

    // The extension exists only in developer mode. The enabled flag is set
    // explicitly because app settings outlive a test launch, and this spec
    // ends by turning the extension off.
    await page.evaluate(async (extensionId) => {
      await window.electronAPI.invoke('developer-mode:set', true);
      await window.electronAPI.invoke('extensions:set-enabled', extensionId, true);
    }, EXTENSION_ID);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await dismissAPIKeyDialog(page);
    await waitForWorkspaceReady(page);

    // Backend modules start only in a trusted project. The test permission
    // mode skips the trust toast without recording trust, so record it.
    await trustWorkspace(page, workspaceDir);
  });

  test.afterEach(async () => {
    // Leave the extension enabled for whatever launches next.
    await page
      ?.evaluate((extensionId) => window.electronAPI.invoke('extensions:set-enabled', extensionId, true), EXTENSION_ID)
      .catch(() => undefined);
    await electronApp?.close().catch(() => undefined);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  test('adds, starts, reads and stops a run target, and stops it when the extension is turned off or the app quits', async () => {
    const panel = page.locator(PLAYWRIGHT_TEST_SELECTORS.runsPanel);
    const row = panel.locator('[data-run-id="web-server"]');
    const badge = page.locator(PLAYWRIGHT_TEST_SELECTORS.runsGutterBadge);

    // Open the Runs panel from its gutter button.
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.runsGutterButton).click();
    await expect(panel).toBeVisible({ timeout: 15000 });

    // Add a target through the form; it is written to .nimbalyst/run.json.
    await panel.locator(PLAYWRIGHT_TEST_SELECTORS.runsAddTargetButton).click({ timeout: 15000 });
    const form = panel.locator(PLAYWRIGHT_TEST_SELECTORS.runsTargetForm);
    await form.getByLabel('Name').fill('Web server');
    await form.getByLabel('Command').fill(`node server.js ${port}`);
    await form.getByLabel('Port (optional)').fill(String(port));
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(row).toHaveAttribute('data-run-status', 'stopped');
    const config = JSON.parse(await fs.readFile(path.join(workspaceDir, '.nimbalyst', 'run.json'), 'utf8'));
    expect(config.targets).toEqual([{ id: 'web-server', name: 'Web server', command: `node server.js ${port}`, port }]);
    await expect(badge).toHaveCount(0);

    // Start: the row turns running once the port answers, and the badge turns green.
    await row.getByRole('button', { name: 'Start Web server', exact: true }).click();
    await expect(row).toHaveAttribute('data-run-status', 'running', { timeout: 20000 });
    await expect(badge).toHaveAttribute('data-tone', 'success');
    expect(await httpGet(port)).toEqual({ status: 200, body: 'run-manager-e2e' });

    // The log an agent reads with run_logs holds the server's own output.
    const readLogs = () =>
      page.evaluate(
        ({ workspacePath, extensionId }) =>
          window.electronAPI.invoke('extensions:ai-call-backend-tool', {
            toolName: 'run.logs',
            args: { id: 'web-server' },
            workspacePath,
            callerExtensionId: extensionId,
          }),
        { workspacePath: workspaceDir, extensionId: EXTENSION_ID }
      ) as Promise<{ text: string }>;
    await expect.poll(async () => (await readLogs()).text, { timeout: 10000 }).toContain('request /');
    expect((await readLogs()).text).toContain(`listening on ${port}`);

    // Logs opens the target's terminal tab; the Runs tab leads back.
    await row.getByRole('button', { name: 'Logs of Web server', exact: true }).click();
    const logTab = page.locator(PLAYWRIGHT_TEST_SELECTORS.commandTerminalTab);
    await expect(logTab).toHaveCount(1);
    await expect(logTab).toHaveAttribute('data-status-tone', 'success');
    const logTerminal = page.locator('.terminal-bottom-panel-terminal:visible');
    await expect(logTerminal.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 10000 });
    await expect(logTerminal.getByText('Initializing terminal...')).toBeHidden({ timeout: 10000 });
    await expect(panel).toBeHidden();
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.terminalOwnerTab).click();
    await expect(panel).toBeVisible();

    // Stop: the process group goes away and the port is free again.
    await row.getByRole('button', { name: 'Stop Web server', exact: true }).click();
    await expect(row).toHaveAttribute('data-run-status', 'stopped', { timeout: 15000 });
    await expect.poll(() => isPortOpen(port), { timeout: 10000 }).toBe(false);
    await expect(badge).toHaveCount(0);

    // Start again, then turn the extension off: the run must stop with it.
    await row.getByRole('button', { name: 'Start Web server', exact: true }).click();
    await expect(row).toHaveAttribute('data-run-status', 'running', { timeout: 20000 });
    expect(await isPortOpen(port)).toBe(true);
    await page.evaluate(
      (extensionId) => window.electronAPI.invoke('extensions:set-enabled', extensionId, false),
      EXTENSION_ID
    );
    await expect.poll(() => isPortOpen(port), { timeout: 15000 }).toBe(false);

    // Turn it back on, start once more, and quit: nothing may outlive the app.
    await page.evaluate(
      (extensionId) => window.electronAPI.invoke('extensions:set-enabled', extensionId, true),
      EXTENSION_ID
    );
    await expect(row).toHaveAttribute('data-run-status', 'stopped', { timeout: 20000 });
    const startAgain = row.getByRole('button', { name: 'Start Web server', exact: true });
    await expect(async () => {
      // The backend module is restarting; a click before it is up reports an error and changes nothing.
      await startAgain.click({ timeout: 2000 });
      await expect(row).toHaveAttribute('data-run-status', 'running', { timeout: 5000 });
    }).toPass({ timeout: 30000 });
    expect(await isPortOpen(port)).toBe(true);
    await electronApp.close();
    await expect.poll(() => isPortOpen(port), { timeout: 15000 }).toBe(false);
  });
});
