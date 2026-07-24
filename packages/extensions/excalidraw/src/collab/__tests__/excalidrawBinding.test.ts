/**
 * Regression test: when ExcalidrawBinding is created against a Y.Doc that
 * already has elements (the recipient case for a shared doc), the binding
 * must populate the Excalidraw canvas with those elements via
 * `api.updateScene`. The previous implementation called `restoreElements`
 * for its normalisation side-effect and discarded the return value, leaving
 * the canvas blank for anyone opening a shared `.excalidraw` after sync.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@excalidraw/excalidraw', () => ({
  // The binding only uses restoreElements for normalisation; in tests we let
  // the input pass through unchanged.
  restoreElements: (elements: any[]) => elements,
}));

import * as Y from 'yjs';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ExcalidrawBinding } from '../excalidrawBindings';
import { seedExcalidrawYDoc } from '../seed';

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
} {
  let sceneElements: any[] = [];
  const updateSceneCalls: Array<{ elements?: any[] }> = [];
  const onChangeListeners = new Set<(...args: any[]) => void>();
  const api = {
    __sceneElements: sceneElements,
    __updateSceneCalls: updateSceneCalls,
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
      }
    }),
    scrollToContent: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI & {
    __sceneElements: any[];
    __updateSceneCalls: Array<{ elements?: any[] }>;
  };
  return api;
}

describe('ExcalidrawBinding initial render', () => {
  it('populates the canvas with elements that are already in the Y.Doc on bind', () => {
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
    expect(sceneUpdate!.elements!.map((el: any) => el.id)).toEqual(['rect-1']);
  });
});
