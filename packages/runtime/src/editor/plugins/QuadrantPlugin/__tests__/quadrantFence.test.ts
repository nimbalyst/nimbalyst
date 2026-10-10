// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import { $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';

import { parseQuadrantFence, setQuadrantFenceSize } from '../quadrantFence';
import { $isQuadrantNode, QuadrantNode } from '../QuadrantNodeCore';
import { QUADRANT_TRANSFORMER } from '../QuadrantTransformer';
import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';

const FENCE = [
  '```2x2',
  'x: Marketer-first, closed -> Developer-first, open',
  'y: Batch -> Realtime decisioning',
  'quadrants: Enterprise suites | Opportunity | Guidance and engagement | Dev-first',
  '- Salesforce: 0.15, 0.85',
  '- UserCurrent: 0.85, 0.9 !',
  '- Broken: high, 0.2',
  '```',
].join('\n');

describe('2x2 fence', () => {
  it('reads labels, points and pinned points, and skips lines it cannot place', () => {
    const body = FENCE.split('\n').slice(1, -1).join('\n');
    expect(parseQuadrantFence(body)).toEqual({
      labels: {
        xLabel: 'Marketer-first, closed -> Developer-first, open',
        yLabel: 'Batch -> Realtime decisioning',
        quadrants: ['Enterprise suites', 'Opportunity', 'Guidance and engagement', 'Dev-first'],
      },
      points: [
        { id: 'p0', label: 'Salesforce', x: 0.15, y: 0.85, pinned: false },
        { id: 'p1', label: 'UserCurrent', x: 0.85, y: 0.9, pinned: true },
      ],
      skipped: 1,
    });
  });

  it('keeps a dragged size as `width:`/`height:` lines; no width means fill the column', () => {
    const body = 'x: Low -> High\n- A: 0.1, 0.2';
    const sized = setQuadrantFenceSize(body, { width: 520.4, height: 433.6 });
    expect(sized).toBe('x: Low -> High\nwidth: 520\nheight: 434\n- A: 0.1, 0.2');
    expect(parseQuadrantFence(sized)).toMatchObject({ width: 520, height: 434 });
    expect(setQuadrantFenceSize(sized, { width: null, height: 300 })).toBe('x: Low -> High\nheight: 300\n- A: 0.1, 0.2');
    expect(parseQuadrantFence('height: 5').height).toBe(200);
  });

  it('round-trips its markdown exactly through the node', () => {
    const editor = createHeadlessEditor({ nodes: [QuadrantNode], onError: (error) => { throw error; } });
    let out = '';
    editor.update(() => $convertFromMarkdownString(`Before\n\n${FENCE}\n\nAfter`, [QUADRANT_TRANSFORMER]), { discrete: true });
    editor.getEditorState().read(() => {
      expect($isQuadrantNode($getRoot().getChildAtIndex(1))).toBe(true);
      out = $convertToMarkdownString([QUADRANT_TRANSFORMER]);
    });
    expect(out).toBe(`Before\n\n${FENCE}\n\nAfter`);
  });

  // Red until the registry lines land (headlessBodyNodes / headlessBodyTransformers):
  // a page body seeded headless must keep the block, not paint blank.
  it('round-trips through the headless body node and transformer set', () => {
    const editor = createHeadlessEditor({ nodes: HeadlessBodyNodes, onError: (error) => { throw error; } });
    const transformers = getHeadlessBodyTransformers();
    let out = '';
    editor.update(() => $convertFromMarkdownString(FENCE, transformers), { discrete: true });
    editor.getEditorState().read(() => {
      // Without the registry lines the core code-block transformer claims the fence.
      expect($isQuadrantNode($getRoot().getFirstChild())).toBe(true);
      out = $convertToMarkdownString(transformers);
    });
    expect(out).toBe(FENCE);
  });
});
