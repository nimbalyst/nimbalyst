// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { exportFileToHtml } from '../FileHtmlExporter';
import { mermaidFenceSources } from '../../../shared/mermaidFences';

const MARKDOWN = [
  '# Landscape',
  '',
  '```2x2',
  'x: Closed -> Open',
  'quadrants: Suites | Opportunity | Guidance | Dev-first',
  '- Acme & Co: 0.2, 0.8',
  '- Us: 0.85, 0.9 !',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```',
  '',
  '```mermaid',
  'pie title Unrendered',
  '  "a" : 1',
  '```',
].join('\n');

describe('shared-link HTML', () => {
  it('draws 2x2 fences as SVG and swaps in the renderer-drawn mermaid diagrams', () => {
    // Keys come from the same extractor the Share dialog uses; the second diagram "failed".
    const [graph] = mermaidFenceSources(MARKDOWN);
    const html = exportFileToHtml('/tmp/landscape.md', MARKDOWN, {
      mermaidSvgs: { [graph]: '<svg id="rendered-graph"></svg>' },
    });

    expect(html).toContain('class="share-diagram share-quadrant"><svg class="quadrant-svg"');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('class="q-point q-pinned"');
    expect(html).not.toContain('language-2x2');

    expect(html).toContain('<div class="share-diagram share-mermaid"><svg id="rendered-graph"></svg></div>');
    // A diagram the renderer could not draw stays readable as code.
    expect(html.match(/class="share-diagram share-mermaid"/g)?.length).toBe(1);
    expect(html).toMatch(/<pre class="hljs"><code>[\s\S]*Unrendered/);
  });
});
