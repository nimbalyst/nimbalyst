/**
 * The browser half of a cross-host collaboration run.
 *
 * `twoClientCollab.ts` gives two Electron clients on one wrangler room. This
 * gives one *browser* client on the same room: the web console's dev-only
 * Shared Docs harness route, served by the console's own Vite dev server and
 * driven through Chromium.
 *
 * Why the dev server and not a built preview. The console's production build
 * (`scripts/build-production.mjs`) resolves the pinned extension's git commit,
 * refuses to build from a dirty extension tree, and stamps provenance -- all
 * correct for a deploy and all hostile to a test that runs against whatever the
 * working tree currently holds. The dev server serves the same pinned bundle
 * through a virtual module with the same host singletons and the same lazy
 * import, in about four seconds. What it does NOT cover is the production emit
 * path (`/extensions/csv-spreadsheet/<version>/index.js`) and the provenance
 * gate; those need their own check.
 */

import { spawn, type ChildProcess } from 'child_process';
import { chromium, type Browser, type Page } from '@playwright/test';

/**
 * The console checkout. Absolute, like the extension fixture paths in
 * `collaborative-document-types.spec.ts`: these repos are siblings on the
 * developer's machine and there is no package that resolves them.
 */
export const WEB_CONSOLE_DIR = process.env.NIMBALYST_WEB_CONSOLE_DIR
  ?? '/Users/ghinkle/sources/nimbalyst-collab/packages/web-console';

/**
 * The repo's Playwright install has no headless-shell download, so Chromium is
 * driven through the system Chrome -- the same executable the console's own
 * `verify-shared-docs-live.mjs` uses.
 */
const CHROME_PATH = process.env.NIMBALYST_E2E_CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface WebConsoleClientOptions {
  /** Vite port for the console. Distinct from the Electron app's 5273. */
  port?: number;
  headless?: boolean;
}

export interface WebConsoleDocumentTarget {
  serverUrl: string;
  orgId: string;
  teamProjectId: string;
  memberId: string;
  displayName: string;
  /** Omit to land on the Shared Docs list rather than a document. */
  documentId?: string;
}

const DEFAULT_PORT = 5179;

export class WebConsoleClient {
  readonly port: number;
  readonly consoleErrors: string[] = [];

  private readonly headless: boolean;
  private vite: ChildProcess | null = null;
  private browser: Browser | null = null;

  constructor(options: WebConsoleClientOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.headless = options.headless ?? true;
  }

  async start(): Promise<void> {
    this.vite = spawn(
      'npm',
      ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(this.port), '--strictPort'],
      { cwd: WEB_CONSOLE_DIR, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await this.waitForViteReady(this.vite);
    this.browser = await chromium.launch({ executablePath: CHROME_PATH, headless: this.headless });
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    const vite = this.vite;
    this.vite = null;
    if (!vite?.pid) return;
    try { vite.kill('SIGTERM'); } catch { /* already exited */ }
  }

  /** A fresh browser context, so two console clients are separate identities. */
  async openPage(target: WebConsoleDocumentTarget): Promise<Page> {
    if (!this.browser) throw new Error('The web console client is not started');
    const context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    // Collected rather than asserted here: the harness route's Stytch SDK call
    // always 400s on an unregistered origin, and a spec that failed on any
    // console error would be failing on that instead of on the product.
    page.on('pageerror', (error) => this.consoleErrors.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(`console error: ${message.text()}`);
    });
    await page.goto(this.harnessUrl(target));
    return page;
  }

  harnessUrl(target: WebConsoleDocumentTarget): string {
    const query = new URLSearchParams({
      serverUrl: target.serverUrl,
      orgId: target.orgId,
      teamProjectId: target.teamProjectId,
      memberId: target.memberId,
      displayName: target.displayName,
      ...(target.documentId
        ? { documentId: target.documentId, projectId: target.teamProjectId }
        : {}),
    });
    return `http://127.0.0.1:${this.port}/__collab-docs-harness?${query}`;
  }

  private waitForViteReady(vite: ChildProcess, timeoutMs = 90_000): Promise<void> {
    const marker = `http://127.0.0.1:${this.port}`;
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error(`The web console dev server did not start.\n${output}`)),
        timeoutMs,
      );
      const onData = (chunk: Buffer | string) => {
        output += String(chunk);
        if (!output.includes(marker)) return;
        clearTimeout(timer);
        resolve();
      };
      vite.stdout?.on('data', onData);
      vite.stderr?.on('data', onData);
      vite.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The web console dev server exited with ${code}.\n${output}`));
      });
    });
  }
}
