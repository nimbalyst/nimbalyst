import { describe, expect, it } from 'vitest';
import { rehypeAutolinkFilePaths, __test } from '../rehypeAutolinkFilePaths';

const { splitTextNode } = __test;

/** Collect the file paths that `splitTextNode` would turn into anchors. */
function linkedPaths(text: string): string[] {
  const nodes = splitTextNode(text);
  if (!nodes) return [];
  return nodes
    .filter((n: any) => n.type === 'element' && n.tagName === 'a')
    .map((n: any) => n.properties.dataFilePath as string);
}

describe('rehypeAutolinkFilePaths path detection', () => {
  describe('should link', () => {
    const cases: Array<[string, string[]]> = [
      ['/Users/a/foo.ts', ['/Users/a/foo.ts']],
      ['/Users/a/foo.ts:42', ['/Users/a/foo.ts:42']],
      ['/Users/a/foo.ts:42:7', ['/Users/a/foo.ts:42:7']],
      ['packages/electron/src/foo.ts', ['packages/electron/src/foo.ts']],
      ['See packages/electron/src/foo.ts for details.', ['packages/electron/src/foo.ts']],
      ['edit ./src/index.tsx now', ['./src/index.tsx']],
      ['(see /Users/a/foo.ts)', ['/Users/a/foo.ts']],
      ['C:\\proj\\foo.ts', ['C:\\proj\\foo.ts']],
      ['C:/proj/foo.ts:10', ['C:/proj/foo.ts:10']],
      [
        'both a/b/one.ts and c/d/two.js here',
        ['a/b/one.ts', 'c/d/two.js'],
      ],
    ];
    it.each(cases)('links %j', (input, expected) => {
      expect(linkedPaths(input)).toEqual(expected);
    });
  });

  describe('should NOT link', () => {
    const cases: string[] = [
      'and/or',
      'TODO/DONE',
      'either/or decisions',
      'foo.ts', // bare filename, no separator
      'package.json', // bare filename, no separator
      'v1.2.3',
      '9.99',
      'https://example.com/a/b.ts',
      'read more at http://nimbalyst.com/docs/index.html',
      'just some prose without any path',
    ];
    it.each(cases)('does not link %j', (input) => {
      expect(linkedPaths(input)).toEqual([]);
    });
  });

  it('preserves surrounding text when splitting', () => {
    const nodes = splitTextNode('open packages/a/foo.ts please')!;
    expect(nodes.map((n: any) => (n.type === 'text' ? n.value : `[${n.properties.dataFilePath}]`))).toEqual([
      'open ',
      '[packages/a/foo.ts]',
      ' please',
    ]);
  });
});

describe('rehypeAutolinkFilePaths tree transform', () => {
  const run = (tree: any) => {
    rehypeAutolinkFilePaths()(tree);
    return tree;
  };

  it('skips fenced code (pre) and existing anchors, but links inline code', () => {
    const tree = {
      type: 'root',
      children: [
        // Inline code: should be linked.
        { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'src/a/foo.ts' }] },
        // Fenced code block: must be left alone.
        {
          type: 'element',
          tagName: 'pre',
          children: [
            { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'src/a/bar.ts' }] },
          ],
        },
        // Existing link: must be left alone.
        {
          type: 'element',
          tagName: 'a',
          properties: { href: 'x' },
          children: [{ type: 'text', value: 'src/a/baz.ts' }],
        },
      ],
    };
    run(tree);
    const code = tree.children[0] as any;
    const pre = tree.children[1] as any;
    const anchor = tree.children[2] as any;
    // Inline code now wraps the path in an anchor.
    expect(code.children[0]).toMatchObject({ type: 'element', tagName: 'a' });
    expect(code.children[0].properties.dataFilePath).toBe('src/a/foo.ts');
    // Fenced code and existing-anchor subtrees are untouched.
    expect(pre.children[0].children[0]).toEqual({ type: 'text', value: 'src/a/bar.ts' });
    expect(anchor.children[0]).toEqual({ type: 'text', value: 'src/a/baz.ts' });
  });

  it('links a path inside a paragraph element', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [{ type: 'text', value: 'check src/a/foo.ts' }],
        },
      ],
    };
    run(tree);
    const p = tree.children[0] as any;
    const anchor = p.children.find((n: any) => n.type === 'element' && n.tagName === 'a');
    expect(anchor.properties.dataFilePath).toBe('src/a/foo.ts');
  });
});
