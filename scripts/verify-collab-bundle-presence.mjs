#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const collabBundleRoot = path.join(repoRoot, 'packages/collab-bundle');
const collabV3Root = path.resolve(repoRoot, '../nimbalyst-collab/packages/collabv3');
const wranglerPort = 8794;
const harnessPort = 4187;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function waitForOutput(process, marker, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${marker}.\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      resolve(output);
    };
    process.stdout?.on('data', onData);
    process.stderr?.on('data', onData);
    process.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Process exited with ${code}.\n${output}`));
    });
  });
}

export function terminateProcessGroup(process) {
  if (!process?.pid) return;
  try {
    process.kill('SIGTERM');
  } catch {
    // Already stopped.
  }
}

export async function seedServerManagedOrg(orgId, actorUserId) {
  const base = `http://127.0.0.1:${wranglerPort}/sync/org:${orgId}:team/internal`;
  const query = `test_user_id=${encodeURIComponent(actorUserId)}&test_org_id=${encodeURIComponent(orgId)}`;
  const post = (endpoint, body) => fetch(`${base}/${endpoint}?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const metadata = await post('set-metadata', {
    orgId,
    name: orgId,
    createdBy: actorUserId,
  });
  if (!metadata.ok) throw new Error(`set-metadata failed: ${metadata.status} ${await metadata.text()}`);
  const custody = await post('set-key-custody-mode', {
    mode: 'server-managed',
    actorUserId,
  });
  if (!custody.ok) throw new Error(`set-key-custody-mode failed: ${custody.status} ${await custody.text()}`);
}

export async function createHarness(tempRoot) {
  const editorEntry = path.join(collabBundleRoot, 'dist/editor.js');
  const stylesEntry = path.join(collabBundleRoot, 'dist/styles.css');
  await writeFile(path.join(tempRoot, 'main.js'), `
import {
  asTeamDocumentId,
  asTeamOrgId,
  asTeamProjectId,
  mountCollabEditor,
} from ${JSON.stringify(editorEntry)};
import ${JSON.stringify(stylesEntry)};

const query = new URLSearchParams(location.search);
const memberId = query.get('memberId');
const displayName = query.get('displayName');
const orgId = query.get('orgId');
const projectId = query.get('projectId');
const documentId = query.get('documentId');
const serverUrl = query.get('serverUrl');
const editorElement = document.getElementById('editor');
const participantsElement = document.getElementById('participants');

let holdDocumentUpdates = false;
const verificationSockets = new Set();

class VerificationWebSocket extends WebSocket {
  queuedDocumentUpdates = [];

  constructor(url) {
    super(url);
    verificationSockets.add(this);
    this.addEventListener('close', () => verificationSockets.delete(this));
  }

  send(data) {
    if (holdDocumentUpdates && typeof data === 'string') {
      try {
        if (JSON.parse(data).type === 'docUpdate') {
          this.queuedDocumentUpdates.push(data);
          return;
        }
      } catch {
        // Non-JSON frames follow the real transport unchanged.
      }
    }
    super.send(data);
  }

  releaseDocumentUpdates() {
    for (const data of this.queuedDocumentUpdates.splice(0)) super.send(data);
  }
}

const handle = mountCollabEditor({
  element: editorElement,
  source: {
    kind: 'team-room',
    serverUrl,
    room: {
      orgId: asTeamOrgId(orgId),
      projectId: asTeamProjectId(projectId),
      documentId: asTeamDocumentId(documentId),
    },
    auth: {
      scope: 'team',
      memberId,
      getTeamJwt: async () => 'local-verification-jwt',
    },
    createWebSocket: (url) => new VerificationWebSocket(
      url + '&test_user_id=' + encodeURIComponent(memberId)
        + '&test_org_id=' + encodeURIComponent(orgId)
    ),
  },
  user: { memberId, name: displayName },
  showToolbar: query.get('showToolbar') !== 'false',
  onStateChange: (state) => {
    document.body.dataset.connection = state.connection;
  },
  onPresenceChange: (presence) => {
    document.body.dataset.participants = JSON.stringify(presence.participants);
    participantsElement.replaceChildren(...presence.participants.map((participant) => {
      const item = document.createElement('div');
      item.dataset.memberId = participant.memberId;
      item.textContent = participant.displayName;
      return item;
    }));
  },
  onReady: () => { document.body.dataset.ready = 'true'; },
  onError: (error) => { document.body.dataset.error = error.message; },
});
window.collabVerification = {
  handle,
  pauseDocumentUpdates() {
    holdDocumentUpdates = true;
  },
  releaseDocumentUpdates() {
    holdDocumentUpdates = false;
    for (const socket of verificationSockets) socket.releaseDocumentUpdates();
  },
  queuedDocumentUpdateCount() {
    let count = 0;
    for (const socket of verificationSockets) count += socket.queuedDocumentUpdates.length;
    return count;
  },
};
`);
  const outputRoot = path.join(tempRoot, 'dist');
  await build({
    configFile: false,
    root: tempRoot,
    logLevel: 'warn',
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
      'process.env': JSON.stringify({ NODE_ENV: 'development' }),
    },
    build: {
      outDir: outputRoot,
      emptyOutDir: true,
      sourcemap: false,
      lib: {
        entry: path.join(tempRoot, 'main.js'),
        formats: ['es'],
        fileName: () => 'main.js',
        cssFileName: 'styles',
      },
    },
  });
  await writeFile(path.join(outputRoot, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Collab presence verification</title><link rel="stylesheet" href="/styles.css"></head>
<body><div id="participants"></div><div id="editor"></div><script type="module" src="/main.js"></script></body></html>`);
  return outputRoot;
}

export function serveHarness(root) {
  const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, `http://127.0.0.1:${harnessPort}`).pathname;
      const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
      const filePath = path.join(root, relativePath);
      const contents = await readFile(filePath);
      const contentType = relativePath.endsWith('.js') || relativePath.endsWith('.mjs')
        ? 'text/javascript; charset=utf-8'
        : relativePath.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(harnessPort, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'nimbalyst-collab-presence-'));
  let wrangler = null;
  let harnessServer = null;
  let browser = null;
  try {
    execFileSync('npx', [
      'wrangler', 'd1', 'migrations', 'apply', 'nimbalyst-collabv3', '--local',
    ], {
      cwd: collabV3Root,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: 'pipe',
    });
    wrangler = spawn('npx', [
      'wrangler', 'dev', '--local', '--port', String(wranglerPort), '--inspector-port', '0',
    ], {
      cwd: collabV3Root,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(wrangler, 'Ready on');

    const orgId = `presence-org-${Date.now()}`;
    const projectId = 'presence-project';
    const documentId = `presence-document-${Date.now()}`;
    await seedServerManagedOrg(orgId, 'member-rowan');
    const outputRoot = await createHarness(tempRoot);
    harnessServer = await serveHarness(outputRoot);

    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
    });
    const rowanContext = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const danaContext = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const rowan = await rowanContext.newPage();
    const dana = await danaContext.newPage();
    const observePage = (label, page) => {
      page.on('pageerror', (error) => console.error(`[${label}] page error:`, error.message));
      page.on('response', (response) => {
        const contentType = response.headers()['content-type'] ?? '';
        if (response.status() >= 400 || contentType.includes('application/octet-stream')) {
          console.error(`[${label}] response ${response.status()} ${contentType}:`, response.url());
        }
      });
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          console.error(`[${label}] console ${message.type()}:`, message.text());
        }
      });
    };
    observePage('rowan', rowan);
    observePage('dana', dana);
    const pageUrl = (memberId, displayName) => {
      const params = new URLSearchParams({
        serverUrl: `ws://127.0.0.1:${wranglerPort}`,
        orgId,
        projectId,
        documentId,
        memberId,
        displayName,
      });
      return `http://127.0.0.1:${harnessPort}/?${params}`;
    };
    await Promise.all([
      rowan.goto(pageUrl('member-rowan', 'Rowan Petrie')),
      dana.goto(pageUrl('member-dana', 'Dana Okafor')),
    ]);
    try {
      await Promise.all([
        rowan.waitForSelector('body[data-connection="connected"]', { timeout: 15_000 }),
        dana.waitForSelector('body[data-connection="connected"]', { timeout: 15_000 }),
      ]);
    } catch (error) {
      const states = await Promise.all([rowan, dana].map((page) => page.evaluate(() => ({
        body: document.body.outerHTML.slice(0, 2_000),
        connection: document.body.dataset.connection,
        error: document.body.dataset.error,
      }))));
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(states, null, 2)}`);
    }
    await Promise.all([
      rowan.waitForFunction(() => document.body.dataset.participants?.includes('Dana Okafor')),
      dana.waitForFunction(() => document.body.dataset.participants?.includes('Rowan Petrie')),
    ]);

    const marker = `LIVE-PRESENCE-${Date.now()}`;
    const rowanEditor = rowan.locator('[contenteditable="true"]');
    await rowanEditor.click();
    await rowan.keyboard.type(marker);
    await dana.waitForFunction(
      (expected) => document.querySelector('[contenteditable="true"]')?.textContent?.includes(expected),
      marker,
    );
    await rowan.keyboard.down('Shift');
    for (let index = 0; index < 8; index += 1) await rowan.keyboard.press('ArrowLeft');
    await rowan.keyboard.up('Shift');
    await dana.waitForFunction(() => {
      const container = document.querySelector('.collab-cursors-container');
      return container?.textContent?.includes('Rowan Petrie')
        && container.querySelectorAll(':scope > div > span').length > 0;
    });

    const beforeGracefulClose = await dana.evaluate(() => ({
      participants: JSON.parse(document.body.dataset.participants ?? '[]'),
      cursorLabels: document.querySelector('.collab-cursors-container')?.textContent ?? '',
      selectionRects: document.querySelector('.collab-cursors-container')
        ?.querySelectorAll(':scope > div > span').length ?? 0,
      content: document.querySelector('[contenteditable="true"]')?.textContent ?? '',
    }));
    const gracefulCloseStartedAt = Date.now();
    await rowan.close();
    await dana.waitForFunction(
      () => JSON.parse(document.body.dataset.participants ?? '[]').length === 0,
      undefined,
      { timeout: 2_000 },
    );
    const gracefulCloseRemovalMs = Date.now() - gracefulCloseStartedAt;
    const afterGracefulClose = await dana.evaluate(() => ({
      participants: JSON.parse(document.body.dataset.participants ?? '[]'),
      cursorLabels: document.querySelector('.collab-cursors-container')?.textContent ?? '',
      selectionRects: document.querySelector('.collab-cursors-container')
        ?.querySelectorAll(':scope > div > span').length ?? 0,
    }));

    const rowanHardDrop = await rowanContext.newPage();
    observePage('rowan-hard-drop', rowanHardDrop);
    await rowanHardDrop.goto(pageUrl('member-rowan', 'Rowan Petrie'));
    await rowanHardDrop.waitForSelector('body[data-connection="connected"]', { timeout: 15_000 });
    await dana.waitForFunction(() => document.body.dataset.participants?.includes('Rowan Petrie'));

    const hardDropEditor = rowanHardDrop.locator('[contenteditable="true"]');
    await hardDropEditor.click();
    await rowanHardDrop.keyboard.down('Shift');
    for (let index = 0; index < 8; index += 1) await rowanHardDrop.keyboard.press('ArrowLeft');
    await rowanHardDrop.keyboard.up('Shift');
    await dana.waitForFunction(() => {
      const container = document.querySelector('.collab-cursors-container');
      return container?.textContent?.includes('Rowan Petrie')
        && container.querySelectorAll(':scope > div > span').length > 0;
    });

    // Rejoin immediately before cutting transport so the fallback age starts
    // from a fresh heartbeat rather than an arbitrary point in its 5s cadence.
    await rowanHardDrop.evaluate(() => {
      window.collabVerification.handle.setPresenceActive(false);
    });
    await dana.waitForFunction(
      () => JSON.parse(document.body.dataset.participants ?? '[]').length === 0,
    );
    await rowanHardDrop.evaluate(() => {
      window.collabVerification.handle.setPresenceActive(true);
    });
    await dana.waitForFunction(() => document.body.dataset.participants?.includes('Rowan Petrie'));

    const hardDropStartedAt = Date.now();
    await rowanContext.setOffline(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const duringHardDropFallback = await dana.evaluate(() => ({
      participants: JSON.parse(document.body.dataset.participants ?? '[]'),
      cursorLabels: document.querySelector('.collab-cursors-container')?.textContent ?? '',
      selectionRects: document.querySelector('.collab-cursors-container')
        ?.querySelectorAll(':scope > div > span').length ?? 0,
    }));
    if (duringHardDropFallback.participants.length === 0) {
      throw new Error('Hard drop incorrectly followed the graceful departure path.');
    }
    await dana.waitForFunction(
      () => JSON.parse(document.body.dataset.participants ?? '[]').length === 0,
      undefined,
      { timeout: 20_000 },
    );
    const hardDropRemovalMs = Date.now() - hardDropStartedAt;
    if (hardDropRemovalMs < 12_000) {
      throw new Error(`Hard drop expired before the 15s stale fallback: ${hardDropRemovalMs}ms.`);
    }
    const afterHardDropExpiry = await dana.evaluate(() => ({
      participants: JSON.parse(document.body.dataset.participants ?? '[]'),
      cursorLabels: document.querySelector('.collab-cursors-container')?.textContent ?? '',
      selectionRects: document.querySelector('.collab-cursors-container')
        ?.querySelectorAll(':scope > div > span').length ?? 0,
    }));
    const result = {
      room: { orgId, projectId, documentId },
      connection: 'connected on both clients',
      reciprocalParticipants: {
        rowanSaw: 'Dana Okafor',
        danaSaw: 'Rowan Petrie',
      },
      marker,
      gracefulClose: {
        before: beforeGracefulClose,
        after: afterGracefulClose,
        removalMs: gracefulCloseRemovalMs,
      },
      hardDrop: {
        duringFallback: duringHardDropFallback,
        afterExpiry: afterHardDropExpiry,
        removalMs: hardDropRemovalMs,
      },
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    if (harnessServer) await new Promise((resolve) => harnessServer.close(resolve));
    terminateProcessGroup(wrangler);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
