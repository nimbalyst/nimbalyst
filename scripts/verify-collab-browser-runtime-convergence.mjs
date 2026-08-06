#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build as esbuild } from 'esbuild';
import { chromium } from 'playwright';

import {
  createHarness,
  seedServerManagedOrg,
  serveHarness,
  terminateProcessGroup,
  waitForOutput,
} from './verify-collab-bundle-presence.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const runtimeSourceRoot = path.join(repoRoot, 'packages/runtime/src');
const collabV3Root = path.resolve(repoRoot, '../nimbalyst-collab/packages/collabv3');
const wranglerPort = 8794;
const harnessPort = 4187;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const promptRemovalDeadlineMs = 2_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExact(actual, expected, label) {
  if (actual === expected) return;
  throw new Error(`${label} did not match exactly.\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`);
}

async function waitUntil(read, predicate, label, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

class DocumentUpdateGate {
  paused = false;
  sockets = new Set();

  createWebSocket = (url) => {
    const socket = new WebSocket(url);
    const entry = {
      socket,
      originalSend: socket.send.bind(socket),
      queued: [],
    };
    this.sockets.add(entry);
    socket.addEventListener('close', () => this.sockets.delete(entry));
    socket.send = (data) => {
      if (this.paused && typeof data === 'string') {
        try {
          if (JSON.parse(data).type === 'docUpdate') {
            entry.queued.push(data);
            return;
          }
        } catch {
          // Non-JSON frames follow the real transport unchanged.
        }
      }
      entry.originalSend(data);
    };
    return socket;
  };

  pause() {
    this.paused = true;
  }

  queuedCount() {
    let count = 0;
    for (const entry of this.sockets) count += entry.queued.length;
    return count;
  }

  release() {
    this.paused = false;
    for (const entry of this.sockets) {
      for (const data of entry.queued.splice(0)) entry.originalSend(data);
    }
  }
}

async function buildRuntimeDesktopPeer(tempRoot) {
  const entryPath = path.join(tempRoot, 'runtime-desktop-peer.ts');
  const outputPath = path.join(tempRoot, 'runtime-desktop-peer.mjs');
  const documentSyncPath = path.join(runtimeSourceRoot, 'sync/DocumentSync.ts');
  const lexicalProviderPath = path.join(runtimeSourceRoot, 'sync/CollabLexicalProvider.ts');
  const headlessPath = path.join(runtimeSourceRoot, 'sync/HeadlessLexicalYDoc.ts');
  const headlessNodesPath = path.join(runtimeSourceRoot, 'editor/nodes/headlessBodyNodes.ts');
  const markdownPath = path.join(runtimeSourceRoot, 'editor/markdown/index.ts');

  await writeFile(entryPath, `
import { $getRoot } from 'lexical';
import { DocumentSyncProvider } from ${JSON.stringify(documentSyncPath)};
import { CollabLexicalProvider } from ${JSON.stringify(lexicalProviderPath)};
import { HeadlessLexicalYDoc } from ${JSON.stringify(headlessPath)};
import HeadlessBodyNodes from ${JSON.stringify(headlessNodesPath)};
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from ${JSON.stringify(markdownPath)};

export class RuntimeDesktopPeer {
  constructor(config) {
    this.status = 'disconnected';
    this.destroyed = false;
    this.network = new DocumentSyncProvider({
      serverUrl: config.serverUrl,
      orgId: config.orgId,
      documentId: config.documentId,
      userId: config.userId,
      getJwt: async () => 'local-verification-jwt',
      buildUrl: (roomId) => config.serverUrl + '/sync/' + roomId
        + '?test_user_id=' + encodeURIComponent(config.userId)
        + '&test_org_id=' + encodeURIComponent(config.orgId),
      createWebSocket: config.createWebSocket,
      onStatusChange: (status) => {
        this.status = status;
        this.lexical?.handleStatusChange(status);
      },
    });
    this.lexical = new CollabLexicalProvider(this.network, { deferInitialSync: true });
    this.lexical.prepareForBinding();
    const editorDoc = this.lexical.getYDoc();
    const headlessProvider = {
      awareness: {
        getLocalState: () => null,
        getStates: () => new Map(),
        setLocalState: () => {},
        setLocalStateField: () => {},
        on: () => {},
        off: () => {},
      },
      connect: async () => {},
      disconnect: () => {},
      on: () => {},
      off: () => {},
    };
    this.headless = new HeadlessLexicalYDoc({
      doc: editorDoc,
      nodes: HeadlessBodyNodes,
      provider: headlessProvider,
      namespace: 'w1-runtime-desktop-peer',
    });
    this.lexical.awareness.setLocalState({
      name: config.displayName,
      color: '#7c3aed',
    });
  }

  async connect() {
    await this.lexical.connect();
  }

  getStatus() {
    return this.status;
  }

  hydrate() {
    this.headless.hydrateFromYDoc();
  }

  getMarkdown() {
    return this.headless.editor.getEditorState().read(() => (
      $convertToEnhancedMarkdownString(getEditorTransformers())
    ));
  }

  replaceMarkdown(markdown) {
    this.headless.applyUpdate(() => {
      $getRoot().clear();
      $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
    });
  }

  insertAfter(needle, text) {
    this.headless.hydrateFromYDoc();
    let inserted = false;
    this.headless.applyUpdate(() => {
      for (const textNode of $getRoot().getAllTextNodes()) {
        const content = textNode.getTextContent();
        const index = content.indexOf(needle);
        if (index === -1) continue;
        const offset = index + needle.length;
        textNode.select(offset, offset).insertText(text);
        inserted = true;
        break;
      }
    });
    if (!inserted) throw new Error('Desktop text node did not contain ' + JSON.stringify(needle));
  }

  getPresence() {
    return Array.from(this.lexical.awareness.getStates().values()).map((state) => ({
      name: state.name,
      color: state.color,
    }));
  }

  async flush(timeoutMs = 5_000) {
    return this.network.flushWithAck(timeoutMs);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lexical.destroy();
    this.headless.destroy();
    this.network.destroy();
  }
}
`);

  await esbuild({
    entryPoints: [entryPath],
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    absWorkingDir: repoRoot,
    nodePaths: [path.join(repoRoot, 'node_modules')],
    logLevel: 'warning',
    loader: {
      '.css': 'empty',
      '.svg': 'empty',
      '.png': 'empty',
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
    },
  });
  return import(`${pathToFileURL(outputPath).href}?built=${Date.now()}`);
}

function pageUrl({ orgId, projectId, documentId, memberId, displayName }) {
  const params = new URLSearchParams({
    serverUrl: `ws://127.0.0.1:${wranglerPort}`,
    orgId,
    projectId,
    documentId,
    memberId,
    displayName,
    showToolbar: 'false',
  });
  return `http://127.0.0.1:${harnessPort}/?${params}`;
}

function observePage(label, page) {
  page.on('pageerror', (error) => console.error(`[${label}] page error:`, error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`[${label}] console ${message.type()}:`, message.text());
    }
  });
}

async function browserMarkdown(page) {
  return page.evaluate(() => window.collabVerification.handle.getMarkdown());
}

async function browserParticipants(page) {
  return page.evaluate(() => JSON.parse(document.body.dataset.participants ?? '[]'));
}

async function setBrowserCaretAfter(page, needle) {
  const found = await page.evaluate((expectedNeedle) => {
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) return false;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const index = node.textContent?.indexOf(expectedNeedle) ?? -1;
      if (index === -1) continue;
      const range = document.createRange();
      const offset = index + expectedNeedle.length;
      range.setStart(node, offset);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      editor.focus();
      return true;
    }
    return false;
  }, needle);
  assert(found, `Browser DOM did not contain a single text node with ${JSON.stringify(needle)}.`);
}

async function insertBrowserTextAfter(page, needle, text) {
  await setBrowserCaretAfter(page, needle);
  await page.keyboard.type(text);
}

async function browserStructure(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    const count = (selector) => editor?.querySelectorAll(selector).length ?? 0;
    return {
      headings: count('h1'),
      unorderedLists: count('ul'),
      orderedLists: count('ol'),
      strong: count('strong, b'),
      emphasis: count('em, i'),
      inlineCode: count('.nim-text-code'),
      codeBlocks: count('code.nim-code, code[data-language]'),
      text: editor?.textContent ?? '',
    };
  });
}

async function openPair({ browser, RuntimeDesktopPeer, orgId, projectId, documentId, suffix }) {
  const desktopId = `desktop-${suffix}`;
  const browserId = `browser-${suffix}`;
  const desktopDisplayName = `Runtime Desktop ${suffix}`;
  const browserDisplayName = `Browser ${suffix}`;
  const updateGate = new DocumentUpdateGate();
  const desktop = new RuntimeDesktopPeer({
    serverUrl: `ws://127.0.0.1:${wranglerPort}`,
    orgId,
    documentId,
    userId: desktopId,
    displayName: desktopDisplayName,
    createWebSocket: updateGate.createWebSocket,
  });
  const context = await browser.newContext({ viewport: { width: 960, height: 760 } });
  const page = await context.newPage();
  observePage(suffix, page);

  await Promise.all([
    desktop.connect(),
    page.goto(pageUrl({
      orgId,
      projectId,
      documentId,
      memberId: browserId,
      displayName: browserDisplayName,
    })),
  ]);
  await Promise.all([
    page.waitForSelector('body[data-ready="true"][data-connection="connected"]', { timeout: 15_000 }),
    waitUntil(
      () => desktop.getStatus(),
      (status) => status === 'connected',
      `${suffix} desktop connection`,
    ),
  ]);
  desktop.hydrate();
  await Promise.all([
    waitUntil(
      () => desktop.getPresence(),
      (presence) => presence.some((participant) => participant.name === browserDisplayName),
      `${suffix} browser presence on desktop`,
    ),
    waitUntil(
      () => browserParticipants(page),
      (presence) => presence.some((participant) => participant.displayName === desktopDisplayName),
      `${suffix} desktop presence in browser`,
    ),
  ]);

  return {
    context,
    page,
    desktop,
    updateGate,
    desktopDisplayName,
    browserDisplayName,
    browserId,
  };
}

async function closePair(pair) {
  pair.desktop.destroy();
  await pair.context.close();
}

async function verifyBidirectional(options) {
  const pair = await openPair({ ...options, suffix: 'Bidirectional' });
  try {
    const desktopMarker = `DESKTOP-${Date.now()}`;
    const browserMarker = `BROWSER-${Date.now()}`;
    pair.desktop.replaceMarkdown(`Desktop authored: ${desktopMarker}`);
    const desktopAuthored = pair.desktop.getMarkdown();
    assert(desktopAuthored.includes(desktopMarker), 'Desktop-authored state was unexpectedly empty.');
    const browserObservedDesktop = await waitUntil(
      () => browserMarkdown(pair.page),
      (markdown) => markdown === desktopAuthored,
      'desktop-authored text in browser',
    );
    assertExact(browserObservedDesktop, desktopAuthored, 'Browser observation of desktop edit');

    const browserAddition = ` Browser authored: ${browserMarker}`;
    await insertBrowserTextAfter(pair.page, desktopMarker, browserAddition);
    const expectedFinal = desktopAuthored.replace(desktopMarker, desktopMarker + browserAddition);
    const desktopFinal = await waitUntil(
      () => pair.desktop.getMarkdown(),
      (markdown) => markdown === expectedFinal,
      'browser-authored text on desktop',
    );
    const browserFinal = await waitUntil(
      () => browserMarkdown(pair.page),
      (markdown) => markdown === expectedFinal,
      'browser final bidirectional state',
    );
    assertExact(desktopFinal, expectedFinal, 'Desktop bidirectional final state');
    assertExact(browserFinal, expectedFinal, 'Browser bidirectional final state');
    assert(await pair.desktop.flush(), 'Desktop bidirectional update was not acknowledged by the room.');
    const browserFlush = await pair.page.evaluate(() => window.collabVerification.handle.flush({ timeoutMs: 5_000 }));
    assert(browserFlush.status === 'acknowledged', `Browser bidirectional flush failed: ${JSON.stringify(browserFlush)}`);
    return { desktopAuthored, browserObservedDesktop, expectedFinal, desktopFinal, browserFinal };
  } finally {
    await closePair(pair);
  }
}

async function verifyConcurrentSameParagraph(options) {
  const pair = await openPair({ ...options, suffix: 'Concurrent' });
  try {
    pair.desktop.replaceMarkdown('Concurrent same paragraph: desktop=; browser=.');
    const base = pair.desktop.getMarkdown();
    await waitUntil(() => browserMarkdown(pair.page), (markdown) => markdown === base, 'concurrent base in browser');

    pair.updateGate.pause();
    await pair.page.evaluate(() => window.collabVerification.pauseDocumentUpdates());
    await Promise.all([
      Promise.resolve().then(() => pair.desktop.insertAfter('desktop=', 'RUNTIME')),
      insertBrowserTextAfter(pair.page, 'browser=', 'BUNDLE'),
    ]);

    const desktopLocal = pair.desktop.getMarkdown();
    const browserLocal = await browserMarkdown(pair.page);
    const expectedDesktopLocal = base.replace('desktop=', 'desktop=RUNTIME');
    const expectedBrowserLocal = base.replace('browser=', 'browser=BUNDLE');
    assertExact(desktopLocal, expectedDesktopLocal, 'Desktop isolated concurrent edit');
    assertExact(browserLocal, expectedBrowserLocal, 'Browser isolated concurrent edit');
    assert(!desktopLocal.includes('BUNDLE'), 'Desktop observed the browser edit before the concurrency gate opened.');
    assert(!browserLocal.includes('RUNTIME'), 'Browser observed the desktop edit before the concurrency gate opened.');

    const desktopQueuedUpdates = pair.updateGate.queuedCount();
    const browserQueuedUpdates = await pair.page.evaluate(
      () => window.collabVerification.queuedDocumentUpdateCount(),
    );
    assert(desktopQueuedUpdates > 0, 'Desktop concurrency gate captured no docUpdate frame.');
    assert(browserQueuedUpdates > 0, 'Browser concurrency gate captured no docUpdate frame.');

    pair.updateGate.release();
    await pair.page.evaluate(() => window.collabVerification.releaseDocumentUpdates());
    const expectedFinal = base
      .replace('desktop=', 'desktop=RUNTIME')
      .replace('browser=', 'browser=BUNDLE');
    const [desktopFinal, browserFinal] = await Promise.all([
      waitUntil(() => pair.desktop.getMarkdown(), (markdown) => markdown === expectedFinal, 'desktop concurrent final'),
      waitUntil(() => browserMarkdown(pair.page), (markdown) => markdown === expectedFinal, 'browser concurrent final'),
    ]);
    assertExact(desktopFinal, expectedFinal, 'Desktop concurrent final state');
    assertExact(browserFinal, expectedFinal, 'Browser concurrent final state');
    return {
      base,
      desktopLocal,
      browserLocal,
      desktopQueuedUpdates,
      browserQueuedUpdates,
      expectedFinal,
      desktopFinal,
      browserFinal,
    };
  } finally {
    await closePair(pair);
  }
}

function assertFidelityMarkdown(markdown) {
  const required = [
    '# Runtime Fidelity Heading',
    '**bold**',
    '*italic*',
    '`inline code`',
    '- alpha item',
    '- beta item with **bold list text**',
    '1. first numbered',
    '2. second numbered',
    '```ts',
    'const answer = 42;',
    'console.log(answer);',
  ];
  for (const fragment of required) {
    assert(markdown.includes(fragment), `Fidelity markdown lost ${JSON.stringify(fragment)}.`);
  }
}

async function verifyFidelityAndDepartures(options) {
  const pair = await openPair({ ...options, suffix: 'Fidelity' });
  let desktopDestroyed = false;
  try {
    const authoredSource = [
      '# Runtime Fidelity Heading',
      '',
      'This paragraph has **bold**, *italic*, and `inline code`.',
      '',
      '- alpha item',
      '- beta item with **bold list text**',
      '',
      '1. first numbered',
      '2. second numbered',
      '',
      '```ts',
      'const answer = 42;',
      'console.log(answer);',
      '```',
    ].join('\n');
    pair.desktop.replaceMarkdown(authoredSource);
    const desktopAuthored = pair.desktop.getMarkdown();
    assertFidelityMarkdown(desktopAuthored);
    const browserAuthored = await waitUntil(
      () => browserMarkdown(pair.page),
      (markdown) => markdown === desktopAuthored,
      'desktop fidelity document in browser',
    );
    assertExact(browserAuthored, desktopAuthored, 'Browser fidelity hydration');
    const structureBefore = await browserStructure(pair.page);

    const fidelityAddition = 'a browser edit plus ';
    await insertBrowserTextAfter(pair.page, 'This paragraph has ', fidelityAddition);
    const expectedFinal = desktopAuthored.replace(
      'This paragraph has ',
      `This paragraph has ${fidelityAddition}`,
    );
    const [desktopFinal, browserFinal] = await Promise.all([
      waitUntil(() => pair.desktop.getMarkdown(), (markdown) => markdown === expectedFinal, 'desktop fidelity final'),
      waitUntil(() => browserMarkdown(pair.page), (markdown) => markdown === expectedFinal, 'browser fidelity final'),
    ]);
    assertExact(desktopFinal, expectedFinal, 'Desktop fidelity round-trip');
    assertExact(browserFinal, expectedFinal, 'Browser fidelity round-trip');
    assertFidelityMarkdown(desktopFinal);
    const structureAfter = await browserStructure(pair.page);
    const structuralCounts = ['headings', 'unorderedLists', 'orderedLists', 'strong', 'emphasis', 'inlineCode', 'codeBlocks'];
    for (const key of structuralCounts) {
      assert(
        structureAfter[key] === structureBefore[key],
        `Browser edit changed fidelity DOM count ${key}: ${structureBefore[key]} -> ${structureAfter[key]}.`,
      );
    }
    assert(structureAfter.headings === 1, 'Fidelity heading did not render as one heading.');
    assert(structureAfter.unorderedLists === 1, 'Fidelity unordered list did not survive.');
    assert(structureAfter.orderedLists === 1, 'Fidelity ordered list did not survive.');
    assert(structureAfter.strong >= 2, 'Fidelity bold formatting did not survive in both locations.');
    assert(structureAfter.emphasis >= 1, 'Fidelity italic formatting did not survive.');
    assert(structureAfter.inlineCode >= 1, 'Fidelity inline code did not survive.');
    assert(structureAfter.codeBlocks === 1, 'Fidelity code block did not survive.');

    const browserDepartureStartedAt = Date.now();
    await pair.page.close();
    await waitUntil(
      () => pair.desktop.getPresence(),
      (presence) => presence.length === 0,
      'browser graceful departure on desktop',
      promptRemovalDeadlineMs,
    );
    const browserToDesktopMs = Date.now() - browserDepartureStartedAt;
    assert(
      browserToDesktopMs < promptRemovalDeadlineMs,
      `Browser departure took ${browserToDesktopMs}ms and may have used stale expiry.`,
    );

    const replacementPage = await pair.context.newPage();
    observePage('Fidelity-rejoin', replacementPage);
    await replacementPage.goto(pageUrl({
      orgId: options.orgId,
      projectId: options.projectId,
      documentId: options.documentId,
      memberId: pair.browserId,
      displayName: pair.browserDisplayName,
    }));
    await replacementPage.waitForSelector('body[data-ready="true"][data-connection="connected"]', { timeout: 15_000 });
    await Promise.all([
      waitUntil(
        () => pair.desktop.getPresence(),
        (presence) => presence.some((participant) => participant.name === pair.browserDisplayName),
        'rejoined browser presence on desktop',
      ),
      waitUntil(
        () => browserParticipants(replacementPage),
        (presence) => presence.some((participant) => participant.displayName === pair.desktopDisplayName),
        'desktop presence on rejoined browser',
      ),
      waitUntil(() => browserMarkdown(replacementPage), (markdown) => markdown === expectedFinal, 'fidelity state after browser rejoin'),
    ]);

    const desktopDepartureStartedAt = Date.now();
    pair.desktop.destroy();
    desktopDestroyed = true;
    await waitUntil(
      () => browserParticipants(replacementPage),
      (presence) => presence.length === 0,
      'desktop graceful departure in browser',
      promptRemovalDeadlineMs,
    );
    const desktopToBrowserMs = Date.now() - desktopDepartureStartedAt;
    assert(
      desktopToBrowserMs < promptRemovalDeadlineMs,
      `Desktop departure took ${desktopToBrowserMs}ms and may have used stale expiry.`,
    );

    return {
      authoredSource,
      desktopAuthored,
      browserAuthored,
      expectedFinal,
      desktopFinal,
      browserFinal,
      structureBefore,
      structureAfter,
      survived: ['heading', 'unordered list', 'ordered list', 'bold', 'italic', 'inline code', 'TypeScript code block'],
      damaged: [],
      departures: {
        browserToDesktopMs,
        desktopToBrowserMs,
        promptDeadlineMs: promptRemovalDeadlineMs,
      },
    };
  } finally {
    if (!desktopDestroyed) pair.desktop.destroy();
    await pair.context.close();
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'nimbalyst-browser-runtime-convergence-'));
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

    const runId = Date.now();
    const orgId = `w1-cross-build-org-${runId}`;
    const projectId = 'w1-cross-build-project';
    await seedServerManagedOrg(orgId, 'desktop-seed');
    const outputRoot = await createHarness(tempRoot);
    harnessServer = await serveHarness(outputRoot);
    const { RuntimeDesktopPeer } = await buildRuntimeDesktopPeer(tempRoot);

    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const shared = { browser, RuntimeDesktopPeer, orgId, projectId };
    const bidirectional = await verifyBidirectional({
      ...shared,
      documentId: `w1-bidirectional-${runId}`,
    });
    const concurrentSameParagraph = await verifyConcurrentSameParagraph({
      ...shared,
      documentId: `w1-concurrent-${runId}`,
    });
    const fidelity = await verifyFidelityAndDepartures({
      ...shared,
      documentId: `w1-fidelity-${runId}`,
    });

    console.log(JSON.stringify({
      room: { orgId, projectId },
      desktopProxy: {
        covered: 'DocumentSyncProvider + CollabLexicalProvider + per-mount editor-doc bridge, driven by HeadlessLexicalYDoc in Node',
        notCovered: [
          'Electron shell and renderer lifecycle',
          'Electron main-process WebSocket proxy',
          'desktop React DOM, toolbar, focus, and OS integration',
          'disk-backed replica/autosave integration',
        ],
      },
      bidirectional,
      concurrentSameParagraph,
      fidelity,
    }, null, 2));
  } finally {
    await browser?.close();
    if (harnessServer) await new Promise((resolve) => harnessServer.close(resolve));
    terminateProcessGroup(wrangler);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
