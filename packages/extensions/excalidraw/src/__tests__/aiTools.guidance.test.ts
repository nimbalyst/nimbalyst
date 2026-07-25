import { describe, expect, it, vi } from 'vitest';

vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: vi.fn((elements: unknown[]) => elements),
}));
vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
  parseMermaidToExcalidraw: vi.fn(),
}));

import { aiTools } from '../aiTools';

describe('Excalidraw AI tool guidance', () => {
  it('directs agents to hidden editors instead of the visible test opener', () => {
    for (const tool of aiTools) {
      expect(tool.description, tool.name).toContain('does not need to be open');
      expect(tool.description, tool.name).toContain('Do not call extension_test_open_file first');
    }
  });
});
