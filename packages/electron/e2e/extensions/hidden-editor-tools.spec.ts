/**
 * Hidden Editor Tool Execution E2E Tests
 *
 * Tests that AI agents can use extension MCP tools (e.g., Excalidraw)
 * against files that are NOT open in a visible tab. The HiddenTabManager
 * mounts editors offscreen and the extension's API registers, allowing
 * tools to execute transparently.
 *
 * Uses __nimbalyst_extension_tools__ (dev-mode only) to call
 * executeExtensionTool directly through the same bridge as MCP tool calls.
 *
 * Run with: npx playwright test e2e/extensions/hidden-editor-tools.spec.ts
 * Requires: Nimbalyst dev server running (npm run dev)
 */

import { test, expect } from '@nimbalyst/extension-sdk/testing';
import * as path from 'path';
import * as fs from 'fs';

function createExcalidrawFile() {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [{
      id: 'seed-rect', type: 'rectangle',
      x: 10, y: 10, width: 100, height: 50,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 2, roughness: 1, opacity: 100,
      angle: 0, groupIds: [], frameId: null,
      roundness: { type: 3 }, boundElements: [],
      updated: 1700000000000, link: null, locked: false,
      version: 1, versionNonce: 1, isDeleted: false, seed: 12345,
    }],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }, null, 2);
}

test('hidden editor: read, write, and verify without visible tab', async ({ page }) => {
  const workspacePath = await page.evaluate(async () => {
    const state = await (window as any).electronAPI.getInitialState?.();
    return state?.workspacePath || '';
  });
  if (!workspacePath) {
    test.skip(true, 'No workspace path available');
    return;
  }

  // Unique filename to avoid cache collisions between runs
  const testFileName = `hidden-e2e-${Date.now()}.excalidraw`;
  const testFilePath = path.join(workspacePath, testFileName);
  fs.writeFileSync(testFilePath, createExcalidrawFile(), 'utf8');

  // Helper: call extension tool through the dev-mode bridge
  async function callTool(toolName: string, args: Record<string, unknown> = {}) {
    return page.evaluate(
      async ({ toolName, args, testFilePath, workspacePath }: any) => {
        const bridge = (window as any).__nimbalyst_extension_tools__;
        if (!bridge?.executeExtensionTool) throw new Error('Extension tools bridge not available (dev mode only)');
        return bridge.executeExtensionTool('excalidraw.' + toolName, { ...args, filePath: testFilePath }, {
          workspacePath,
          activeFilePath: testFilePath,
        });
      },
      { toolName, args, testFilePath, workspacePath }
    );
  }

  // Helper: check tab bar for excalidraw files
  async function hasExcalidrawTab(): Promise<boolean> {
    const tabs = await page.locator('[data-testid="tab-title"], .tab-title').allTextContents();
    return tabs.some(t => t.includes('.excalidraw'));
  }

  try {
    // No excalidraw tab open before test
    expect(await hasExcalidrawTab()).toBe(false);

    // Read elements from closed file via hidden editor
    const readResult: any = await callTool('get_elements');
    expect(readResult.success).not.toBe(false);

    // No tab appeared after read
    expect(await hasExcalidrawTab()).toBe(false);

    // Write a new element
    const addResult: any = await callTool('add_rectangle', { label: 'E2ERect', x: 300, y: 300 });
    expect(addResult.success).not.toBe(false);
    expect(addResult.data?.id).toBeDefined();

    // Verify write by reading back
    const verifyResult: any = await callTool('get_elements');
    const labels = (verifyResult.data?.elements || [])
      .map((e: any) => (e.label || '').replace(/\n/g, ''))
      .filter(Boolean);
    expect(labels).toContain('E2ERect');

    // Still no tab after write
    expect(await hasExcalidrawTab()).toBe(false);

    // Verify changes persisted to disk (auto-save with 100ms debounce)
    await new Promise(r => setTimeout(r, 500));
    const diskContent = fs.readFileSync(testFilePath, 'utf8');
    const diskData = JSON.parse(diskContent);
    expect(diskData.elements.length).toBeGreaterThanOrEqual(2);
  } finally {
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
  }
});

/**
 * Regression for NIM-905: a hidden editor mounted to serve a READ-only tool
 * must not flush its (now-stale) buffer back over an out-of-band write to disk.
 *
 * Repro: open a file via a read tool (mounts a hidden editor holding content A),
 * then rewrite the file on disk out-of-band (content B, as an agent's Edit/Write
 * would), then call a read tool again. Before the fix, the bridge's post-tool
 * flush wrote the hidden editor's stale model (A) back, reverting the agent's
 * write. After the fix, the read tool's flush is gated/conflict-aware and disk
 * keeps content B.
 */
test('hidden editor: read-only tool does not clobber an out-of-band disk write', async ({ page }) => {
  const workspacePath = await page.evaluate(async () => {
    const state = await (window as any).electronAPI.getInitialState?.();
    return state?.workspacePath || '';
  });
  if (!workspacePath) {
    test.skip(true, 'No workspace path available');
    return;
  }

  const testFileName = `hidden-clobber-${Date.now()}.excalidraw`;
  const testFilePath = path.join(workspacePath, testFileName);

  // Content A: single seed rectangle.
  fs.writeFileSync(testFilePath, createExcalidrawFile(), 'utf8');

  function makeElement(id: string, x: number): any {
    return {
      id, type: 'rectangle', x, y: 10, width: 100, height: 50,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 2, roughness: 1, opacity: 100,
      angle: 0, groupIds: [], frameId: null,
      roundness: { type: 3 }, boundElements: [],
      updated: 1700000000001, link: null, locked: false,
      version: 2, versionNonce: 2, isDeleted: false, seed: 99999,
    };
  }

  // Content B: two elements that did NOT come from the editor -- simulates an
  // agent rewriting the file on disk while the hidden editor holds content A.
  function createOutOfBandFile() {
    return JSON.stringify({
      type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
      elements: [makeElement('oob-1', 200), makeElement('oob-2', 400)],
      appState: { viewBackgroundColor: '#ffffff' }, files: {},
    }, null, 2);
  }

  async function callTool(toolName: string, args: Record<string, unknown> = {}) {
    return page.evaluate(
      async ({ toolName, args, testFilePath, workspacePath }: any) => {
        const bridge = (window as any).__nimbalyst_extension_tools__;
        if (!bridge?.executeExtensionTool) throw new Error('Extension tools bridge not available (dev mode only)');
        return bridge.executeExtensionTool('excalidraw.' + toolName, { ...args, filePath: testFilePath }, {
          workspacePath,
          activeFilePath: testFilePath,
        });
      },
      { toolName, args, testFilePath, workspacePath }
    );
  }

  const baselineContent = createExcalidrawFile();

  try {
    // Mount the hidden editor via a read tool; let mount + any post-tool flush settle.
    const firstRead: any = await callTool('get_elements');
    expect(firstRead.success).not.toBe(false);
    await new Promise(r => setTimeout(r, 400));

    // Register a pre-edit history tag so the file watcher correlates the
    // out-of-band write to an AI session and routes it through DocumentModel's
    // DIFF branch (onDiffRequested) -- the path the hidden host does NOT handle,
    // so the hidden editor's model stays stale. This reproduces the real Claude
    // Code agent flow (see agent-edit-focus.spec.ts for the same technique).
    await page.evaluate(async ({ workspacePath, filePath, content }: any) => {
      await (window as any).electronAPI.history.createTag(
        workspacePath,
        filePath,
        `hidden-clobber-tag-${Date.now()}`,
        content,
        'hidden-clobber-session',
        'tool-hidden-clobber',
      );
    }, { workspacePath, filePath: testFilePath, content: baselineContent });
    await new Promise(r => setTimeout(r, 200));

    // Out-of-band rewrite (the "agent" edit). Then call the read tool again so
    // its post-tool flush runs against the (stale) hidden editor model.
    fs.writeFileSync(testFilePath, createOutOfBandFile(), 'utf8');
    const secondRead: any = await callTool('get_elements');
    expect(secondRead.success).not.toBe(false);

    // Run another read tool for good measure (each post-tool flush is a chance
    // to clobber). Wait past every flush debounce + the hidden-editor TTL window.
    await callTool('get_elements');
    await new Promise(r => setTimeout(r, 1000));

    // Disk must still hold the out-of-band content (2 elements), not be reverted
    // to the hidden editor's stale single-element buffer.
    const diskData = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
    const ids = (diskData.elements || []).map((e: any) => e.id);
    expect(ids).toContain('oob-1');
    expect(ids).toContain('oob-2');
    expect(diskData.elements.length).toBe(2);
  } finally {
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
  }
});
