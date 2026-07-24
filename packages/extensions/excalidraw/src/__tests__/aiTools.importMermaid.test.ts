import { beforeEach, describe, expect, it, vi } from 'vitest';

// aiTools imports these two @excalidraw value exports at module load. Mock them
// so the tool can run in plain Node without the browser-only excalidraw bundle.
vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: vi.fn((elements: unknown[]) => elements),
}));
vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
  parseMermaidToExcalidraw: vi.fn(),
}));

import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';
import { aiTools } from '../aiTools';

const parseMock = parseMermaidToExcalidraw as unknown as ReturnType<typeof vi.fn>;

function importMermaidHandler(): (params: any, context: any) => Promise<any> {
  const tool = aiTools.find((t) => t.name === 'import_mermaid');
  if (!tool) throw new Error('import_mermaid tool not found');
  return tool.handler as (params: any, context: any) => Promise<any>;
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    getSceneElements: () => [],
    updateScene: vi.fn(),
    addFiles: vi.fn(),
    ...overrides,
  };
}

describe('import_mermaid tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the rendered image files via addFiles so they are not dropped (#428)', async () => {
    const fileId = 'mermaid-file-1';
    const files = {
      [fileId]: { id: fileId, mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 },
    };
    parseMock.mockResolvedValue({ elements: [{ type: 'image', fileId }], files });

    const api = makeApi();
    const result = await importMermaidHandler()({ mermaid: 'flowchart LR; A-->B' }, { editorAPI: api });

    expect(result).toMatchObject({ success: true });
    // The blob must be registered, otherwise the image element references a
    // fileId with no data and renders as a broken thumbnail (#428).
    expect(api.addFiles).toHaveBeenCalledTimes(1);
    expect(api.addFiles).toHaveBeenCalledWith(Object.values(files));
    expect(api.updateScene).toHaveBeenCalled();
  });

  it('does not call addFiles when the diagram produced no files', async () => {
    parseMock.mockResolvedValue({ elements: [{ type: 'rectangle' }], files: {} });

    const api = makeApi();
    await importMermaidHandler()({ mermaid: 'flowchart LR; A-->B' }, { editorAPI: api });

    expect(api.addFiles).not.toHaveBeenCalled();
    expect(api.updateScene).toHaveBeenCalled();
  });

  it('succeeds when the diagram converts natively and files is undefined', async () => {
    // parseMermaidToExcalidraw only populates `files` for the image fallback;
    // natively-converted diagrams return `files: undefined`. The handler must
    // not throw "Cannot convert undefined or null to object" on it.
    parseMock.mockResolvedValue({ elements: [{ type: 'rectangle' }], files: undefined });

    const api = makeApi();
    const result = await importMermaidHandler()({ mermaid: 'graph TD; A-->B' }, { editorAPI: api });

    expect(result).toMatchObject({ success: true });
    expect(api.addFiles).not.toHaveBeenCalled();
    expect(api.updateScene).toHaveBeenCalled();
  });

  it('rewrites <br/> tags in skeleton labels to newlines before conversion', async () => {
    parseMock.mockResolvedValue({
      elements: [
        { type: 'rectangle', label: { text: 'iOS app<br/>SwiftUI' } },
        { type: 'text', text: 'a<br>b<BR />c' },
      ],
      files: undefined,
    });

    const api = makeApi();
    const result = await importMermaidHandler()({ mermaid: 'graph TD; A-->B' }, { editorAPI: api });

    expect(result).toMatchObject({ success: true });
    const sceneElements = api.updateScene.mock.calls[0][0].elements;
    expect(sceneElements.find((el: any) => el.type === 'rectangle').label.text).toBe('iOS app\nSwiftUI');
    expect(sceneElements.find((el: any) => el.type === 'text').text).toBe('a\nb\nc');
  });

  it('reports the image fallback instead of claiming a native import', async () => {
    // When mermaid-to-excalidraw cannot convert natively it renders the whole
    // diagram as a single image element. That must be surfaced to the caller,
    // not reported as a normal "1 skeleton -> 1 elements" success.
    const fileId = 'mermaid-file-2';
    const files = {
      [fileId]: { id: fileId, mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml;base64,AAAA', created: 1 },
    };
    parseMock.mockResolvedValue({ elements: [{ type: 'image', fileId }], files });

    const api = makeApi();
    const result = await importMermaidHandler()({ mermaid: 'graph TD; A-->B' }, { editorAPI: api });

    expect(result.success).toBe(true);
    expect(String(result.message)).toMatch(/image/i);
    expect(String(result.message)).not.toMatch(/1 skeleton → 1 elements/);
  });
});
