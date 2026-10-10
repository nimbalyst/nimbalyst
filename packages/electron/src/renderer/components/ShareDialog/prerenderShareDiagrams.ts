import { renderMermaid } from '@nimbalyst/runtime/editor/plugins/MermaidPlugin/mermaidRender';

import { mermaidFenceSources } from '../../../shared/mermaidFences';

/**
 * Mermaid SVG for each diagram in a markdown file, keyed by fence source, so
 * the shared-link HTML shows diagrams instead of code. A diagram that fails
 * to render is left out and stays a code block.
 */
export async function prerenderMermaidForShare(filePath: string): Promise<Record<string, string> | undefined> {
  if (!/\.(md|markdown|mdx)$/i.test(filePath)) return undefined;
  const file = await window.electronAPI?.readFileContent?.(filePath);
  const content = file && typeof file === 'object' && 'content' in file && typeof file.content === 'string' ? file.content : null;
  if (!content) return undefined;
  const sources = mermaidFenceSources(content);
  if (sources.length === 0) return undefined;
  const svgs: Record<string, string> = {};
  for (const [index, source] of sources.entries()) {
    try {
      // Light theme: the share page shows mermaid on a light card in both themes.
      const { svg } = await renderMermaid(`share-mermaid-${Date.now()}-${index}`, source, false);
      svgs[source] = svg;
    } catch (error) {
      console.warn('[Share] Mermaid diagram did not render; it stays a code block.', error);
    }
  }
  return svgs;
}
