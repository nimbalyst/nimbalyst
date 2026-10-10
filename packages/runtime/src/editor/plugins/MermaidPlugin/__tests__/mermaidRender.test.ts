import { describe, expect, it } from 'vitest';
import { renderMermaid } from '../mermaidRender';

describe('renderMermaid', () => {
  it('preserves the edge group used by SVG styles when rendering a flowchart', async () => {
    // jsdom lacks SVG measurements. Geometry is deliberately not asserted here;
    // this exercises Mermaid's real renderer and the selectors in its emitted SVG.
    const bbox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
    });
    try {
      const { svg } = await renderMermaid('mermaid_edges_test', 'flowchart TD\n A --> B', false);
      const rendered = new DOMParser().parseFromString(svg, 'image/svg+xml');
      expect(rendered.querySelector('.edgePaths path')).not.toBeNull();
      expect(rendered.querySelector('style')?.textContent).toContain('.edgePaths .path');
    } finally {
      if (bbox) Object.defineProperty(SVGElement.prototype, 'getBBox', bbox);
      else delete (SVGElement.prototype as any).getBBox;
    }
  });

  // A leaked temp container stays in document.body below the app root, makes the
  // document taller than the viewport, and lets scrollIntoView push the window
  // title bar off-screen.
  it('leaves nothing in document.body when the diagram fails to parse', async () => {
    const elementId = 'mermaid_leak_test';
    const bodyChildrenBefore = document.body.children.length;

    await expect(
      renderMermaid(elementId, 'flowchart TD\n  A --> B\n  B -->> ((', false),
    ).rejects.toBeTruthy();

    expect(document.getElementById(`d${elementId}`)).toBeNull();
    expect(document.getElementById(elementId)).toBeNull();
    expect(document.body.children.length).toBe(bodyChildrenBefore);
  });
});
