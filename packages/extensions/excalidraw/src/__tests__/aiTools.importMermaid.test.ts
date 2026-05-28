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
});
