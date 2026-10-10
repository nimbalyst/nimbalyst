// @vitest-environment jsdom
/**
 * An agent's extension tool (excalidraw_add_elements and the rest) on a shared
 * page that no tab has open (NIM-7397). The hidden mount must bind the
 * extension's editor to the page's shared document, and a tool may run only
 * once the editor is bound to it: an editor registers its API before its Yjs
 * binding exists, and a write in that gap is lost.
 */
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '@nimbalyst/runtime';

const URI = 'collab://org:org-1:doc:drawing-1';
const registered = new Set<string>();
const order: string[] = [];
let bindLater: (() => void) | null = null;
const acquisitionRelease = vi.fn();

function StubDrawing({ host }: { host: EditorHost & { collaboration?: { registerContentFlush(f: () => void): void } } }) {
  useEffect(() => {
    order.push(`mounted:${host.filePath}`);
    host.registerEditorAPI({ addElements: () => undefined });
    // The binding arrives after the API, as Excalidraw's does.
    bindLater = () => {
      host.collaboration?.registerContentFlush(() => undefined);
      order.push('bound');
    };
  }, [host]);
  return null;
}

vi.mock('@nimbalyst/runtime', () => ({
  createEditorAPIOwnerToken: (id: string) => ({ id }),
  createExtensionStorage: () => ({}),
  getExtensionLoader: () => ({ findEditorForExtension: () => null }),
  hasExtensionEditorAPI: (path: string) => registered.has(path),
  registerEditorAPI: (path: string) => { registered.add(path); },
  unregisterEditorAPI: (path: string) => { registered.delete(path); },
}));

vi.mock('../HeadlessCollabDocument', () => ({
  acquireHeadlessCollabDocument: vi.fn(async () => {
    const flushes = new Set<() => void>();
    return {
      document: { documentId: 'drawing-1', title: 'Architecture', documentType: 'excalidraw', fileExtension: '.excalidraw', editorId: 'com.nimbalyst.excalidraw' },
      documentType: 'excalidraw',
      collabConfig: { orgId: 'org-1', documentId: 'drawing-1', teamMemberId: 'm1' },
      collaboration: { registerContentFlush: (f: () => void) => { flushes.add(f); }, flushes },
      syncProvider: { hasUndecodedContent: () => false },
      release: acquisitionRelease,
    };
  }),
  assertDecodable: () => undefined,
}));

vi.mock('../../components/CustomEditors', () => ({
  customEditorRegistry: {
    findRegistrationForFile: (name: string) => (name.endsWith('.excalidraw')
      ? { extensionId: 'com.nimbalyst.excalidraw', component: StubDrawing, collaboration: { supported: true } }
      : undefined),
  },
}));

vi.mock('../../components/TabEditor/collabExtensionHost', () => ({
  createCollabExtensionHost: (args: { filePath: string; collaboration: unknown; editorAPIOwnerToken?: unknown }) => ({
    filePath: args.filePath,
    collaboration: args.collaboration,
    registerEditorAPI: (api: unknown) => { if (api) registered.add(args.filePath); },
  }),
  hasContentFlush: (collaboration: { flushes: Set<unknown> }) => collaboration.flushes.size > 0,
}));

import { hiddenTabManager } from '../HiddenTabManager';

afterEach(() => {
  registered.clear();
  order.length = 0;
  bindLater = null;
  vi.useRealTimers();
});

describe('HiddenTabManager on a shared page', () => {
  it('mounts the page editor from its collab:// URI and waits for the binding before a tool runs', async () => {
    let ready = false;
    const ensuring = hiddenTabManager.ensureEditor(URI, '/ws').then(() => { ready = true; });
    await vi.waitFor(() => expect(order).toContain(`mounted:${URI}`));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The API is registered, but the editor is not bound to the shared document yet.
    expect(registered.has(URI)).toBe(true);
    expect(ready).toBe(false);

    bindLater!();
    await ensuring;
    expect(order).toEqual([`mounted:${URI}`, 'bound']);

    vi.useFakeTimers();
    hiddenTabManager.release(URI);
    vi.advanceTimersByTime(31_000);
    expect(acquisitionRelease).toHaveBeenCalledTimes(1);
    expect(registered.has(URI)).toBe(false);
  });
});
