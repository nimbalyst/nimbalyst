// @vitest-environment node
/**
 * Regression test: when ExcalidrawBinding is created against a Y.Doc that
 * already has elements (the recipient case for a shared doc), the binding
 * must populate the Excalidraw canvas with those elements via
 * `api.updateScene`. Excalidraw can finish applying its empty initialData
 * after publishing the imperative API, so the binding must also survive that
 * late clear when no future server event exists to repaint the canvas.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'NEVER' },
  // The binding only uses restoreElements for normalisation; in tests we let
  // the input pass through unchanged.
  restoreElements: (elements: any[]) => elements,
}));

import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ExcalidrawBinding } from '../excalidrawBindings';
import { isExcalidrawYDocEmpty, seedExcalidrawYDoc } from '../seed';

const SAMPLE_FILE = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [
    {
      id: 'rect-1',
      type: 'rectangle',
      version: 1,
      versionNonce: 1,
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      angle: 0,
      strokeColor: '#000',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    },
  ],
  appState: {},
  files: {},
});

function createMockApi(): ExcalidrawImperativeAPI & {
  __sceneElements: any[];
  __updateSceneCalls: Array<{ elements?: any[] }>;
  __setSceneElements(elements: any[]): void;
  __emitChangeSnapshot(elements: any[]): void;
} {
  let sceneElements: any[] = [];
  const updateSceneCalls: Array<{ elements?: any[] }> = [];
  const onChangeListeners = new Set<(...args: any[]) => void>();
  const api = {
    __sceneElements: sceneElements,
    __updateSceneCalls: updateSceneCalls,
    __setSceneElements: (elements: any[]) => {
      sceneElements = elements.slice();
      api.__sceneElements = sceneElements;
    },
    __emitChangeSnapshot: (elements: any[]) => {
      for (const listener of onChangeListeners) {
        listener(elements, { selectedElementIds: {} }, {});
      }
    },
    onChange: vi.fn((cb: any) => {
      onChangeListeners.add(cb);
      return () => onChangeListeners.delete(cb);
    }),
    getSceneElements: () => sceneElements,
    getAppState: () => ({}) as any,
    getFiles: () => ({}) as any,
    addFiles: vi.fn(),
    updateScene: vi.fn((payload: { elements?: any[] }) => {
      updateSceneCalls.push(payload);
      if (payload.elements) {
        sceneElements = payload.elements.slice();
        api.__sceneElements = sceneElements;
        const emittedElements = sceneElements;
        setTimeout(() => {
          for (const listener of onChangeListeners) {
            listener(emittedElements, { selectedElementIds: {} }, {});
          }
        }, 0);
      }
    }),
    scrollToContent: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI & {
    __sceneElements: any[];
    __updateSceneCalls: Array<{ elements?: any[] }>;
    __setSceneElements(elements: any[]): void;
    __emitChangeSnapshot(elements: any[]): void;
  };
  return api;
}

describe('ExcalidrawBinding initial render', () => {
  it('does not re-seed an appState-only collaborative document', () => {
    const yDoc = new Y.Doc();
    yDoc.getMap('appState').set('viewBackgroundColor', '#ffffff');

    expect(isExcalidrawYDocEmpty(yDoc)).toBe(false);
    yDoc.destroy();
  });

  it('populates the canvas without letting a stale empty callback erase the Y.Doc', async () => {
    const yDoc = new Y.Doc();
    // Simulate the recipient case: Y.Doc has been hydrated by the server's
    // initial sync, so by the time the binding is created it already has
    // elements.
    yDoc.transact(() => {
      seedExcalidrawYDoc(yDoc, SAMPLE_FILE);
    });

    const api = createMockApi();

    new ExcalidrawBinding(
      yDoc.getArray('elements'),
      yDoc.getMap('assets'),
      api,
    );

    const sceneUpdate = api.__updateSceneCalls.find(
      (call) => Array.isArray(call.elements) && call.elements.length > 0,
    );
    expect(sceneUpdate, 'binding should call updateScene with the synced elements').toBeDefined();
    expect((sceneUpdate as any).captureUpdate).toBe('NEVER');
    expect(sceneUpdate!.elements!.map((el: any) => el.id)).toEqual(['rect-1']);

    // Excalidraw can deliver an initialization callback that was queued while
    // its canvas was still empty after the binding has cold-painted the room.
    // That stale snapshot must not be interpreted as the user deleting every
    // shared element.
    await new Promise((resolve) => setTimeout(resolve, 10));
    api.__emitChangeSnapshot([]);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(
      yDoc
        .getArray<Y.Map<unknown>>('elements')
        .toArray()
        .map((entry) => (entry.get('el') as { id: string }).id),
    ).toEqual(['rect-1']);
  });

  it('repaints a hydrated Y.Doc when Excalidraw clears its scene after API readiness', async () => {
    const yDoc = new Y.Doc();
    yDoc.transact(() => {
      seedExcalidrawYDoc(yDoc, SAMPLE_FILE);
    });
    const api = createMockApi();

    new ExcalidrawBinding(
      yDoc.getArray('elements'),
      yDoc.getMap('assets'),
      api,
    );

    // Mirrors Excalidraw completing its internal initialData application
    // after the imperative API callback unblocked the collaboration binding.
    api.__setSceneElements([]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(api.__sceneElements.map((element) => element.id)).toEqual(['rect-1']);
  });

  it('preserves a local edit when a remote repaint lands before its change callback flushes', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const networkOrigin = {};
    docA.on('update', (update, origin) => {
      if (origin !== networkOrigin) {
        Y.applyUpdate(docB, update, networkOrigin);
      }
    });
    docB.on('update', (update, origin) => {
      if (origin !== networkOrigin) {
        Y.applyUpdate(docA, update, networkOrigin);
      }
    });

    const apiA = createMockApi();
    const apiB = createMockApi();
    const bindingA = new ExcalidrawBinding(
      docA.getArray('elements'),
      docA.getMap('assets'),
      apiA,
    );
    const bindingB = new ExcalidrawBinding(
      docB.getArray('elements'),
      docB.getMap('assets'),
      apiB,
    );

    const elementA = {
      id: 'text-a',
      type: 'text',
      text: 'Alpha',
      version: 1,
      isDeleted: false,
    };
    const elementB = {
      id: 'text-b',
      type: 'text',
      text: 'Bravo',
      version: 1,
      isDeleted: false,
    };

    // Both users have already edited their own canvas. A's debounced callback
    // flushes first, and its remote repaint reaches B before B's callback.
    // The binding must apply B's captured local snapshot, not re-read A's
    // replacement scene from the imperative API.
    apiA.__setSceneElements([elementA]);
    apiB.__setSceneElements([elementB]);
    apiA.__emitChangeSnapshot([elementA]);
    apiB.__emitChangeSnapshot([elementB]);
    // updateScene's onChange echo is asynchronous in the real editor. Wait
    // through a second debounce window so a stale remote repaint would have
    // time to overwrite the queued local snapshot.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(
      docA
        .getArray<Y.Map<unknown>>('elements')
        .toArray()
        .map((entry) => (entry.get('el') as { id: string }).id)
        .sort(),
    ).toEqual(['text-a', 'text-b']);
    expect(
      docB
        .getArray<Y.Map<unknown>>('elements')
        .toArray()
        .map((entry) => (entry.get('el') as { id: string }).id)
        .sort(),
    ).toEqual(['text-a', 'text-b']);
    expect(apiA.__sceneElements.map((element) => element.id).sort()).toEqual([
      'text-a',
      'text-b',
    ]);
    expect(apiB.__sceneElements.map((element) => element.id).sort()).toEqual([
      'text-a',
      'text-b',
    ]);

    bindingA.destroy();
    bindingB.destroy();
    docA.destroy();
    docB.destroy();
  });

  it('pushes a scene still inside the debounce when syncNow drains it', () => {
    // The host calls this after a mutating AI tool. Without it the tool reports
    // success while the element is still waiting out the 50ms delay, and a peer
    // update arriving in that window replaces it.
    const doc = new Y.Doc();
    const api = createMockApi();
    const binding = new ExcalidrawBinding(
      doc.getArray('elements'),
      doc.getMap('assets'),
      api,
    );

    const element = {
      id: 'agent-written',
      type: 'text',
      text: 'From a tool',
      version: 1,
      isDeleted: false,
    };
    api.__setSceneElements([element]);
    api.__emitChangeSnapshot([element]);

    // Nothing has reached the doc yet -- the debounce has not fired.
    expect(doc.getArray('elements').length).toBe(0);

    binding.syncNow();

    expect(
      doc
        .getArray<Y.Map<unknown>>('elements')
        .toArray()
        .map((entry) => (entry.get('el') as { id: string }).id),
    ).toEqual(['agent-written']);

    binding.destroy();
    doc.destroy();
  });

  it('reattaches document and awareness updates to a replacement Excalidraw API', () => {
    const doc = new Y.Doc();
    seedExcalidrawYDoc(doc, SAMPLE_FILE);
    const awareness = new Awareness(doc);
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDoc);
    remoteAwareness.setLocalState({
      user: { name: 'Browser Rowan', color: '#E06B8F' },
    });
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(remoteAwareness, [remoteAwareness.clientID]),
      'test',
    );

    const originalApi = createMockApi();
    const replacementApi = createMockApi();
    const binding = new ExcalidrawBinding(
      doc.getArray('elements'),
      doc.getMap('assets'),
      originalApi,
      awareness,
    );

    binding.replaceApi(replacementApi);

    expect(replacementApi.__sceneElements.map((element) => element.id))
      .toEqual(['rect-1']);
    const replacementCalls = vi.mocked(replacementApi.updateScene).mock.calls;
    expect(replacementCalls.some(([payload]) => (
      payload.collaborators instanceof Map
      && [...payload.collaborators.values()].some(
        (collaborator) => collaborator.username === 'Browser Rowan',
      )
    ))).toBe(true);

    remoteAwareness.setLocalStateField('pointer', { x: 42, y: 17, tool: 'pointer' });
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(remoteAwareness, [remoteAwareness.clientID]),
      'test',
    );
    const latestCollaborators = vi.mocked(replacementApi.updateScene).mock.calls
      .map(([payload]) => payload.collaborators)
      .filter((value) => value instanceof Map)
      .at(-1);
    expect([...latestCollaborators!.values()][0]).toMatchObject({
      username: 'Browser Rowan',
      pointer: { x: 42, y: 17, tool: 'pointer' },
    });

    binding.destroy();
    awareness.destroy();
    remoteAwareness.destroy();
    doc.destroy();
    remoteDoc.destroy();
  });

  it('keeps a local element whose change callback is dispatched after the remote repaint', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const networkOrigin = {};
    docA.on('update', (update, origin) => {
      if (origin !== networkOrigin) Y.applyUpdate(docB, update, networkOrigin);
    });
    docB.on('update', (update, origin) => {
      if (origin !== networkOrigin) Y.applyUpdate(docA, update, networkOrigin);
    });

    const apiA = createMockApi();
    const apiB = createMockApi();
    const bindingA = new ExcalidrawBinding(
      docA.getArray('elements'),
      docA.getMap('assets'),
      apiA,
    );
    const bindingB = new ExcalidrawBinding(
      docB.getArray('elements'),
      docB.getMap('assets'),
      apiB,
    );

    const local = { id: 'text-a', type: 'text', text: 'Alpha', version: 1, isDeleted: false };
    const remote = { id: 'text-b', type: 'text', text: 'Bravo', version: 1, isDeleted: false };

    // A's user draws. Excalidraw has updated its scene but has not yet
    // dispatched the change callback for it.
    apiA.__setSceneElements([local]);

    // B's edit flushes and reaches A first, so A's remote handler repaints the
    // canvas from a Y.Doc that does not contain A's unflushed element.
    apiB.__setSceneElements([remote]);
    apiB.__emitChangeSnapshot([remote]);
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Only now does A's already-queued callback run. Discarding it as stale
    // would delete the element from the canvas and never write it to the Y.Doc.
    apiA.__emitChangeSnapshot([local]);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(
      docA
        .getArray<Y.Map<unknown>>('elements')
        .toArray()
        .map((entry) => (entry.get('el') as { id: string }).id)
        .sort(),
    ).toEqual(['text-a', 'text-b']);
    expect(apiA.__sceneElements.map((element) => element.id).sort()).toEqual([
      'text-a',
      'text-b',
    ]);

    bindingA.destroy();
    bindingB.destroy();
    docA.destroy();
    docB.destroy();
  });

  it('keeps the newest revision when independently seeded duplicate IDs merge', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    // Yjs orders concurrent root-array inserts by client id. Pinning these
    // makes Alice's edited copy precede Bob's stale seed, which reproduces the
    // old reverse-array repair deleting the edited copy deterministically.
    docA.clientID = 1;
    docB.clientID = 2;

    seedExcalidrawYDoc(docA, SAMPLE_FILE);
    seedExcalidrawYDoc(docB, SAMPLE_FILE);
    const aliceEntry = docA.getArray<Y.Map<unknown>>('elements').get(0);
    const aliceElement = aliceEntry.get('el') as Record<string, unknown>;
    aliceEntry.set('el', {
      ...aliceElement,
      version: 2,
      versionNonce: 900,
      x: 200,
    });

    const updateA = Y.encodeStateAsUpdate(docA);
    const updateB = Y.encodeStateAsUpdate(docB);
    const bindingA = new ExcalidrawBinding(
      docA.getArray('elements'),
      docA.getMap('assets'),
      createMockApi(),
    );
    const bindingB = new ExcalidrawBinding(
      docB.getArray('elements'),
      docB.getMap('assets'),
      createMockApi(),
    );

    Y.applyUpdate(docA, updateB, 'network');
    Y.applyUpdate(docB, updateA, 'network');

    for (const doc of [docA, docB]) {
      const elements = doc
        .getArray<Y.Map<unknown>>('elements')
        .toArray()
        .map((entry) => entry.get('el') as {
          id: string;
          version: number;
          versionNonce: number;
          x: number;
        });
      expect(elements).toHaveLength(1);
      expect(elements[0]).toMatchObject({
        id: 'rect-1',
        version: 2,
        versionNonce: 900,
        x: 200,
      });
    }

    bindingA.destroy();
    bindingB.destroy();
    docA.destroy();
    docB.destroy();
  });

  it('uses Excalidraw versionNonce ordering to break duplicate revision ties', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.clientID = 1;
    docB.clientID = 2;

    seedExcalidrawYDoc(docA, SAMPLE_FILE);
    seedExcalidrawYDoc(docB, SAMPLE_FILE);
    const aliceEntry = docA.getArray<Y.Map<unknown>>('elements').get(0);
    const aliceElement = aliceEntry.get('el') as Record<string, unknown>;
    aliceEntry.set('el', {
      ...aliceElement,
      // Excalidraw chooses the lower nonce when versions are equal.
      versionNonce: 0,
      x: 300,
    });

    const updateA = Y.encodeStateAsUpdate(docA);
    const updateB = Y.encodeStateAsUpdate(docB);
    const bindingA = new ExcalidrawBinding(
      docA.getArray('elements'),
      docA.getMap('assets'),
      createMockApi(),
    );
    const bindingB = new ExcalidrawBinding(
      docB.getArray('elements'),
      docB.getMap('assets'),
      createMockApi(),
    );

    Y.applyUpdate(docA, updateB, 'network');
    Y.applyUpdate(docB, updateA, 'network');

    for (const doc of [docA, docB]) {
      const elements = doc
        .getArray<Y.Map<unknown>>('elements')
        .toArray()
        .map((entry) => entry.get('el') as {
          version: number;
          versionNonce: number;
          x: number;
        });
      expect(elements).toHaveLength(1);
      expect(elements[0]).toMatchObject({
        version: 1,
        versionNonce: 0,
        x: 300,
      });
    }

    bindingA.destroy();
    bindingB.destroy();
    docA.destroy();
    docB.destroy();
  });
});
