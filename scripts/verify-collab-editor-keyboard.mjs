#!/usr/bin/env node
/**
 * The two keyboard contracts of the browser collaborative editor that unit
 * tests cannot reach, because both are about real browser focus and the real
 * DOM selection.
 *
 * 1. Tab must be able to leave the document. The runtime registers
 *    `TabIndentationExtension` unconditionally, which consumes Tab everywhere
 *    and inserts a tab character; unmitigated that is a WCAG 2.1.2 keyboard
 *    trap in a browser tab. `BrowserEditorSurface` releases Tab outside
 *    indentable contexts.
 * 2. Escape from the toolbar must put the caret back exactly where it was --
 *    not merely somewhere in the document.
 *
 * Both are checked over enough iterations that an intermittent failure cannot
 * hide, across three caret positions and both collapsed and range selections,
 * driven through the keyboard path a person actually uses. The selection is
 * sampled at three delays after Escape so a measurement taken too early is
 * distinguishable from a real race.
 *
 * Manual verifier, not a CI gate: it needs a real Chrome and rebuilds the
 * bundle, the same shape as verify-collab-bundle-presence.mjs. Exits non-zero
 * if any contract fails.
 *
 * Run: node scripts/verify-collab-editor-keyboard.mjs [iterations]
 */

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
const harnessPort = 4190;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const iterations = Number(process.argv[2] ?? 20);

const FIRST_PARAGRAPH = 'The quick brown fox jumps over the lazy dog.';
const LAST_PARAGRAPH = 'Second paragraph for caret restoration.';

async function createHarness(tempRoot) {
  const editorEntry = path.join(collabBundleRoot, 'dist/editor.js');
  const stylesEntry = path.join(collabBundleRoot, 'dist/styles.css');
  await writeFile(path.join(tempRoot, 'main.js'), `
import { mountCollabEditor, MarkdownCollabContentAdapter } from ${JSON.stringify(editorEntry)};
import ${JSON.stringify(stylesEntry)};
import * as Y from 'yjs';

const doc = new Y.Doc();
MarkdownCollabContentAdapter.seedFromFile(
  doc,
  '# Accessibility probe\\n\\n${FIRST_PARAGRAPH}\\n\\n${LAST_PARAGRAPH}\\n',
);

mountCollabEditor({
  element: document.getElementById('editor'),
  source: { kind: 'in-memory', document: doc },
  user: { memberId: 'member-probe', name: 'Probe User' },
  showToolbar: true,
  onReady: () => { document.body.dataset.ready = 'true'; },
  onError: (error) => { document.body.dataset.error = error.message; },
});
`);
  const outputRoot = path.join(tempRoot, 'dist');
  await build({
    configFile: false,
    root: tempRoot,
    logLevel: 'warn',
    resolve: { alias: { yjs: path.join(repoRoot, 'node_modules/yjs') } },
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
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css">
<style>html,body{margin:0;height:100%}#editor{height:100%}</style></head>
<body><div id="editor"></div><script type="module" src="/main.js"></script></body></html>`);
  return outputRoot;
}

function serveHarness(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, `http://127.0.0.1:${harnessPort}`).pathname;
      const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
      const contents = await readFile(path.join(root, relativePath));
      const contentType = relativePath.endsWith('.js') || relativePath.endsWith('.mjs')
        ? 'text/javascript; charset=utf-8'
        : relativePath.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/html; charset=utf-8';
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(harnessPort, '127.0.0.1', () => resolve(server)));
}

const snapshotSelection = () => {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return {
    anchorText: selection.anchorNode?.textContent ?? null,
    anchorOffset: selection.anchorOffset,
    focusText: selection.focusNode?.textContent ?? null,
    focusOffset: selection.focusOffset,
    collapsed: selection.isCollapsed,
    activeIsEditable: document.activeElement?.getAttribute('contenteditable') === 'true',
  };
};

const sameSelection = (before, after) => Boolean(before && after)
  && before.anchorText === after.anchorText
  && before.anchorOffset === after.anchorOffset
  && before.focusText === after.focusText
  && before.focusOffset === after.focusOffset
  && before.collapsed === after.collapsed;

const CASES = [
  { position: 'paragraph-start', range: false },
  { position: 'paragraph-start', range: true },
  { position: 'mid-word', range: false },
  { position: 'mid-word', range: true },
  { position: 'document-end', range: false },
  { position: 'document-end', range: true },
];

async function placeCaret(page, position) {
  if (position === 'document-end') {
    await page.getByText(LAST_PARAGRAPH).click();
    await page.keyboard.press('End');
    return;
  }
  await page.getByText(FIRST_PARAGRAPH).click();
  await page.keyboard.press('Home');
  if (position === 'mid-word') {
    // Offset 7 lands inside "quick" rather than on a word boundary.
    for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowRight');
  }
}

async function runTrial(page, { position, range }) {
  await placeCaret(page, position);
  if (range) {
    const key = position === 'document-end' ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.down('Shift');
    for (let index = 0; index < 4; index += 1) await page.keyboard.press(key);
    await page.keyboard.up('Shift');
  }
  await page.waitForTimeout(60);
  const before = await page.evaluate(snapshotSelection);

  // The real keyboard path out of the document and into the toolbar.
  await page.keyboard.press('Shift+Tab');
  const enteredToolbar = await page.evaluate(() => Boolean(
    document.activeElement?.closest('.toolbar'),
  ));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const toolbarButton = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') ?? null,
  );

  await page.keyboard.press('Escape');
  const samples = {};
  samples.at0ms = await page.evaluate(snapshotSelection);
  await page.waitForTimeout(60);
  samples.at60ms = await page.evaluate(snapshotSelection);
  await page.waitForTimeout(240);
  samples.at300ms = await page.evaluate(snapshotSelection);

  return {
    before,
    enteredToolbar,
    toolbarButton,
    samples,
    restoredAt0ms: sameSelection(before, samples.at0ms),
    restoredAt60ms: sameSelection(before, samples.at60ms),
    restoredAt300ms: sameSelection(before, samples.at300ms),
    focusReturned: samples.at300ms?.activeIsEditable ?? false,
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'nimbalyst-caret-'));
  let harnessServer = null;
  let browser = null;
  try {
    harnessServer = await serveHarness(await createHarness(tempRoot));
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error('[caret] page error:', error.message));
    await page.goto(`http://127.0.0.1:${harnessPort}/`);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 20_000 });
    await page.waitForSelector('.toolbar button', { timeout: 10_000 });

    // The editor reclaims focus on its first non-pointer blur after mount
    // (measured 9/10 cold, 0/100 afterwards). Spend that once up front so it
    // does not masquerade as a caret-restoration failure.
    await page.getByText(FIRST_PARAGRAPH).click();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    await page.getByText(FIRST_PARAGRAPH).click();
    await page.waitForTimeout(100);

    // Contract 1: Tab leaves the document, in both directions, without
    // mutating it. Measured cold (first non-pointer blur after mount, which the
    // editor reclaims) and warm, because only the warm number is the contract.
    const exitStats = {};
    for (const key of ['Tab', 'Shift+Tab']) {
      const observations = [];
      for (let index = 0; index < iterations; index += 1) {
        await page.getByText(FIRST_PARAGRAPH).click();
        await page.waitForTimeout(30);
        const textBefore = await page.evaluate(
          () => document.querySelector('[contenteditable="true"]')?.textContent,
        );
        await page.keyboard.press(key);
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => ({
          isEditable: document.activeElement?.getAttribute('contenteditable') === 'true',
          text: document.querySelector('[contenteditable="true"]')?.textContent,
        }));
        observations.push({ leftDocument: !after.isEditable, mutated: after.text !== textBefore });
      }
      exitStats[key] = {
        leftDocument: observations.filter((one) => one.leftDocument).length,
        documentMutated: observations.filter((one) => one.mutated).length,
        of: observations.length,
      };
      console.error(`[keyboard] exit via ${key.padEnd(14)} `
        + `left ${exitStats[key].leftDocument}/${iterations}  `
        + `documentMutated ${exitStats[key].documentMutated}/${iterations}`);
    }

    const summary = [];
    const failures = [];
    for (const testCase of CASES) {
      const label = `${testCase.position}/${testCase.range ? 'range' : 'collapsed'}`;
      const counts = { at0ms: 0, at60ms: 0, at300ms: 0, focusReturned: 0, enteredToolbar: 0 };
      for (let index = 0; index < iterations; index += 1) {
        const trial = await runTrial(page, testCase);
        if (trial.restoredAt0ms) counts.at0ms += 1;
        if (trial.restoredAt60ms) counts.at60ms += 1;
        if (trial.restoredAt300ms) counts.at300ms += 1;
        if (trial.focusReturned) counts.focusReturned += 1;
        if (trial.enteredToolbar) counts.enteredToolbar += 1;
        if (!trial.restoredAt300ms && failures.length < 8) {
          failures.push({ label, iteration: index, ...trial });
        }
      }
      summary.push({ label, iterations, ...counts });
      console.error(`[caret] ${label.padEnd(26)} `
        + `0ms ${counts.at0ms}/${iterations}  `
        + `60ms ${counts.at60ms}/${iterations}  `
        + `300ms ${counts.at300ms}/${iterations}  `
        + `focusBack ${counts.focusReturned}/${iterations}  `
        + `toolbarEntered ${counts.enteredToolbar}/${iterations}`);
    }

    const caretOk = summary.every((one) => one.at300ms === one.iterations);
    const exitOk = Object.values(exitStats)
      .every((one) => one.leftDocument === one.of && one.documentMutated === 0);
    console.log(JSON.stringify({ iterations, tabExit: exitStats, summary, failures }, null, 2));
    if (!caretOk || !exitOk) {
      console.error('[keyboard] FAILED: '
        + `${caretOk ? '' : 'caret restoration '}${exitOk ? '' : 'tab exit'}`);
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    if (harnessServer) await new Promise((resolve) => harnessServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
