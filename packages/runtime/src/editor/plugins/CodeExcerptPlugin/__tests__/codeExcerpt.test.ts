// @vitest-environment node
/**
 * The code excerpt fence round-trips byte-for-byte (including a snapshot that
 * itself holds a ``` fence), edits keep header keys this version does not
 * read, and the drift badge classifies a file against the snapshot.
 */

import { describe, expect, it } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import { $getNodeByKey, $getRoot } from 'lexical';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { fenceRoundTrip } from '../../fencedBlock/__tests__/fenceRoundTrip';
import { $createCodeExcerptNode, $replaceExcerptSource, CodeExcerptNode } from '../CodeExcerptNodeCore';
import { CODE_EXCERPT_TRANSFORMER } from '../CodeExcerptTransformer';
import { classifyExcerptDrift } from '../excerptDrift';
import { excerptSizeAttrs, parseExcerptRef, parseExcerptSource, setExcerptSize, updateExcerptSource } from '../excerptSource';

const withExcerpt = {
  nodes: [...HeadlessBodyNodes, CodeExcerptNode],
  transformers: [CODE_EXCERPT_TRANSFORMER, ...getHeadlessBodyTransformers()],
};

const EXCERPT = `Scopes:

\`\`\`excerpt
path: packages/runtime/src/auth/jwtScopes.ts
lines: 10-12
commit: 749eca9a4
reviewer: kept
---
export type PersonalJwt = string & { __scope: 'personal' };

export type TeamJwt = string & { __scope: 'team' };
\`\`\`

After.`;

const NESTED_FENCE = `\`\`\`\`excerpt
path: docs/README.md
lines: 3-6
---
Example:
\`\`\`ts
run();
\`\`\`
\`\`\`\``;

describe('code excerpt fence', () => {
  it.each([
    ['plain', EXCERPT],
    ['snapshot holding a fence', NESTED_FENCE],
  ])('%s survives a headless round trip byte-for-byte', (_name, markdown) => {
    const trip = fenceRoundTrip(markdown, withExcerpt);
    expect(trip.errors).toEqual([]);
    expect(trip.blockTypes).toContain('code-excerpt');
    expect(trip.blockTypes).not.toContain('code');
    expect(trip.exported.trim()).toBe(markdown);
    expect(trip.reexported).toBe(trip.exported);
  });

  it('parses the header and keeps the snapshot verbatim', () => {
    const body = EXCERPT.split('```excerpt\n')[1].split('\n```')[0];
    const parsed = parseExcerptSource(body);
    expect(parsed).toMatchObject({ path: 'packages/runtime/src/auth/jwtScopes.ts', range: { start: 10, end: 12 }, commit: '749eca9a4', error: null });
    expect(parsed.snapshot.split('\n')).toHaveLength(3);
  });

  it('updates lines, commit and snapshot without touching other header keys', () => {
    const next = updateExcerptSource('path: a.ts\nlines: 10-12\n# why we quote this\nreviewer: kept\n---\nold', {
      range: { start: 14, end: 15 },
      commit: 'abc123def',
      snapshot: 'new 1\nnew 2',
    });
    expect(next).toBe('path: a.ts\nlines: 14-15\n# why we quote this\nreviewer: kept\ncommit: abc123def\n---\nnew 1\nnew 2');
  });

  it('reads the reference forms people paste', () => {
    expect(parseExcerptRef('src/a.ts#L10-L40')).toEqual({ path: 'src/a.ts', range: { start: 10, end: 40 } });
    expect(parseExcerptRef('src/a.ts:7')).toEqual({ path: 'src/a.ts', range: { start: 7, end: 7 } });
    expect(parseExcerptRef('src/a.ts#L40-L10')).toEqual({ path: 'src/a.ts', range: null });
  });
});

describe('excerpt drift', () => {
  const file = ['line 1', 'line 2', 'const a = 1;', 'const b = 2;', 'line 5'].join('\n') + '\n';
  const snapshot = 'const a = 1;\nconst b = 2;';

  it('is unchanged when the range holds the snapshot (trailing whitespace ignored)', () => {
    expect(classifyExcerptDrift('const a = 1;  \nconst b = 2;', file, { start: 3, end: 4 })).toEqual({ state: 'unchanged' });
  });

  it('is moved when the snapshot is intact elsewhere, picking the nearest copy', () => {
    const shifted = `added\nadded\n${file}`;
    expect(classifyExcerptDrift(snapshot, shifted, { start: 3, end: 4 })).toEqual({ state: 'moved', movedTo: { start: 5, end: 6 } });
    const twice = `${snapshot}\n${'x\n'.repeat(20)}${snapshot}\n`;
    expect(classifyExcerptDrift(snapshot, twice, { start: 20, end: 21 })).toEqual({ state: 'moved', movedTo: { start: 23, end: 24 } });
  });

  it('is changed when the lines differ, carrying what the range holds now', () => {
    const edited = file.replace('const b = 2;', 'const b = 3;');
    expect(classifyExcerptDrift(snapshot, edited, { start: 3, end: 4 })).toEqual({ state: 'changed', current: 'const a = 1;\nconst b = 3;' });
  });

  it('is missing when the file is gone', () => {
    expect(classifyExcerptDrift(snapshot, null, { start: 3, end: 4 })).toEqual({ state: 'missing' });
  });
});

describe('excerpt writes', () => {
  it('drops a write whose source changed since the request started', () => {
    const editor = createHeadlessEditor({ nodes: [CodeExcerptNode], onError: (error) => { throw error; } });
    let key = '';
    editor.update(() => {
      const node = $createCodeExcerptNode({ source: 'path: a.ts\nlines: 1\n---\nold' });
      $getRoot().append(node);
      key = node.getKey();
    }, { discrete: true });
    editor.update(() => {
      // A collaborator edited the block after the read began.
      ($getNodeByKey(key) as CodeExcerptNode).setSource('path: a.ts\nlines: 1\n---\nteammate edit');
    }, { discrete: true });
    let applied = true;
    editor.update(() => {
      applied = $replaceExcerptSource(key, 'path: a.ts\nlines: 1\n---\nold', 'path: a.ts\nlines: 1\n---\nfrom disk');
    }, { discrete: true });
    expect(applied).toBe(false);
    editor.read(() => expect(($getNodeByKey(key) as CodeExcerptNode).getSource()).toContain('teammate edit'));
  });
});

describe('excerpt size', () => {
  it('a grip drag sets header keys without touching the snapshot, and a reset removes them', () => {
    const source = 'path: a.ts\nlines: 1-2\n---\nwidth: 9\nconst x = 1;';
    const sized = setExcerptSize(source, { width: '480', height: '200' });
    expect(sized).toBe('path: a.ts\nlines: 1-2\nwidth: 480\nheight: 200\n---\nwidth: 9\nconst x = 1;');
    expect(excerptSizeAttrs(sized)).toEqual({ width: '480', height: '200' });
    expect(parseExcerptSource(sized).snapshot).toBe('width: 9\nconst x = 1;');
    expect(setExcerptSize(sized, { width: null, height: null })).toBe(source);
  });
});
