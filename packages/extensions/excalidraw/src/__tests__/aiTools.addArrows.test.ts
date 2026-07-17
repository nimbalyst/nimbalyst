import { beforeEach, describe, expect, it, vi } from 'vitest';

// aiTools imports these two @excalidraw value exports at module load. Mock them
// so the tool can run in plain Node without the browser-only excalidraw bundle.
// convertToExcalidrawElements is an identity passthrough that stamps an id,
// mirroring the real API closely enough to assert on the skeletons we build.
vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: vi.fn((elements: any[]) =>
    elements.map((el, i) => ({ id: el.id ?? `conv-${el.type}-${i}`, ...el }))
  ),
}));
vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
  parseMermaidToExcalidraw: vi.fn(),
}));

import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { aiTools } from '../aiTools';

const convertMock = convertToExcalidrawElements as unknown as ReturnType<typeof vi.fn>;

function handlerFor(name: string): (params: any, context: any) => Promise<any> {
  const tool = aiTools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool.handler as (params: any, context: any) => Promise<any>;
}

// A scene with two labeled rectangles (bound text elements, as Excalidraw
// stores them). The "iOS app" label is stored re-wrapped with a newline and
// trailing space, the way Excalidraw wraps text to fit its container.
function makeScene() {
  return [
    { id: 'rect-1', type: 'rectangle', x: 0, y: 0, width: 150, height: 80, boundElements: [{ id: 'text-1', type: 'text' }] },
    { id: 'text-1', type: 'text', x: 10, y: 10, width: 130, height: 25, text: 'iOS \napp ', originalText: 'iOS app', containerId: 'rect-1' },
    { id: 'rect-2', type: 'rectangle', x: 300, y: 0, width: 150, height: 80, boundElements: [{ id: 'text-2', type: 'text' }] },
    { id: 'text-2', type: 'text', x: 310, y: 10, width: 130, height: 25, text: 'IndexRoom', originalText: 'IndexRoom', containerId: 'rect-2' },
  ];
}

function makeApi(scene = makeScene()) {
  return {
    getSceneElements: () => scene,
    updateScene: vi.fn(),
    addFiles: vi.fn(),
  };
}

describe('add_arrows tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a bound label text for arrows with a label option', async () => {
    const api = makeApi();
    const result = await handlerFor('add_arrows')(
      { arrows: [{ from: 'IndexRoom', to: 'iOS app', label: 'notifies' }] },
      { editorAPI: api }
    );

    expect(result.success).toBe(true);
    // The arrow must be built via a skeleton that carries the label so
    // Excalidraw creates a bound, measured text element for it.
    const skeletons = convertMock.mock.calls.flatMap((c) => c[0]);
    const arrowSkeleton = skeletons.find((s: any) => s.type === 'arrow');
    expect(arrowSkeleton).toBeDefined();
    expect(arrowSkeleton.label).toMatchObject({ text: 'notifies' });

    // Everything convert produced (arrow + bound text) must reach the scene.
    const sceneUpdate = api.updateScene.mock.calls[0][0];
    const added = sceneUpdate.elements.filter((el: any) => !makeScene().some((s) => s.id === el.id));
    expect(added.some((el: any) => el.type === 'arrow')).toBe(true);
  });

  it('binds arrow endpoints to the containers (startBinding/endBinding + boundElements)', async () => {
    const api = makeApi();
    await handlerFor('add_arrows')(
      { arrows: [{ from: 'iOS app', to: 'IndexRoom' }] },
      { editorAPI: api }
    );

    const sceneUpdate = api.updateScene.mock.calls[0][0];
    const arrow = sceneUpdate.elements.find((el: any) => el.type === 'arrow');
    expect(arrow.startBinding).toMatchObject({ elementId: 'rect-1' });
    expect(arrow.endBinding).toMatchObject({ elementId: 'rect-2' });

    const rect1 = sceneUpdate.elements.find((el: any) => el.id === 'rect-1');
    expect(rect1.boundElements).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: arrow.id, type: 'arrow' })])
    );
  });

  it('matches endpoints by element id', async () => {
    const api = makeApi();
    const result = await handlerFor('add_arrows')(
      { arrows: [{ from: 'rect-1', to: 'rect-2' }] },
      { editorAPI: api }
    );

    expect(result.success).toBe(true);
    expect(result.data.created).toBe(1);
    expect(result.data.errors).toBeUndefined();
  });

  it('matches endpoints whose stored label was re-wrapped with newlines and trailing spaces', async () => {
    // Stored text is 'iOS \napp ' — the caller passes the original 'iOS app'.
    // originalText matches here, but even without it the whitespace-normalized
    // comparison must succeed.
    const scene = makeScene().map((el) =>
      el.id === 'text-1' ? { ...el, originalText: undefined } : el
    );
    const result = await handlerFor('add_arrows')(
      { arrows: [{ from: 'iOS app', to: 'IndexRoom' }] },
      { editorAPI: makeApi(scene as any) }
    );

    expect(result.success).toBe(true);
    expect(result.data.created).toBe(1);
    expect(result.data.errors).toBeUndefined();
  });
});

describe('add_arrow tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a bound label text when label is provided', async () => {
    const api = makeApi();
    const result = await handlerFor('add_arrow')(
      { from: 'iOS app', to: 'IndexRoom', label: 'syncs' },
      { editorAPI: api }
    );

    expect(result.success).toBe(true);
    const skeletons = convertMock.mock.calls.flatMap((c) => c[0]);
    const arrowSkeleton = skeletons.find((s: any) => s.type === 'arrow');
    expect(arrowSkeleton.label).toMatchObject({ text: 'syncs' });
  });
});
