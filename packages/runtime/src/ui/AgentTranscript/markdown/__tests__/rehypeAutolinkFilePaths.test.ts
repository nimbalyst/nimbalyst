// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rehypeAutolinkFilePaths, __test } from '../rehypeAutolinkFilePaths';

const { splitTextNode } = __test;

/** The anchors that `splitTextNode` would build, in order. */
function anchors(text: string): any[] {
  return (splitTextNode(text) ?? []).filter((n: any) => n.type === 'element' && n.tagName === 'a');
}

/** Collect the file paths that `splitTextNode` would turn into anchors. */
function linkedPaths(text: string): string[] {
  return anchors(text).map((n: any) => n.properties.dataFilePath as string);
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
      ['~/x/y.md', ['~/x/y.md']],
      [
        'both a/b/one.ts and c/d/two.js here',
        ['a/b/one.ts', 'c/d/two.js'],
      ],
    ];
    it.each(cases)('links %j', (input, expected) => {
      expect(linkedPaths(input)).toEqual(expected);
    });
  });

  /**
   * The extension was capped at 8 characters, so anything longer was linked
   * only up to the cap and the remainder fell outside the anchor — the href
   * pointed at a path that does not exist. `.excalidraw` is Nimbalyst's own
   * extension, so its diagrams were unopenable from the transcript:
   *
   *   docs/diagrams/01-one-box.excalidraw  ->  docs/diagrams/01-one-box.excalidr
   */
  describe('extensions longer than 8 characters', () => {
    const cases: Array<[string, string[]]> = [
      ['docs/diagrams/01-one-box.excalidraw', ['docs/diagrams/01-one-box.excalidraw']],
      ['src/app.properties', ['src/app.properties']],
      ['a/b/Main.storyboard', ['a/b/Main.storyboard']],
      ['docs/diagrams/flow.excalidraw:12', ['docs/diagrams/flow.excalidraw:12']],
      // This repo ships an iOS package, so these appear in real transcripts.
      ['packages/ios/App.xcworkspace', ['packages/ios/App.xcworkspace']],
      ['packages/ios/App/App.entitlements', ['packages/ios/App/App.entitlements']],
    ];
    it.each(cases)('links the whole extension in %j', (input, expected) => {
      expect(linkedPaths(input)).toEqual(expected);
    });

    it('still links short extensions unchanged', () => {
      expect(linkedPaths('packages/electron/src/foo.ts')).toEqual([
        'packages/electron/src/foo.ts',
      ]);
    });
  });

  /**
   * Agents often write a file as `@docs/plan.md`, the same "@" shorthand people
   * use to mention a file in a chat box. The "@" is not part of the real path,
   * so clicking the link used to look for `<workspace>/@docs/plan.md`, which
   * does not exist. The link must open `docs/plan.md` while the words on screen
   * stay `@docs/plan.md`.
   */
  describe('a leading "@" on a path', () => {
    it('opens the path without the "@" but still shows the "@"', () => {
      const [anchor] = anchors('@docs/plan.md');
      expect(anchor.properties.dataFilePath).toBe('docs/plan.md');
      expect(anchor.children).toEqual([{ type: 'text', value: '@docs/plan.md' }]);
    });

    it('keeps a :line:col suffix after dropping the "@"', () => {
      expect(linkedPaths('@docs/plan.md:42:7')).toEqual(['docs/plan.md:42:7']);
    });

    it('works in the middle of a sentence', () => {
      expect(linkedPaths('Please read @docs/plan.md first.')).toEqual(['docs/plan.md']);
    });

    it('links "@~/x/y.md" as "~/x/y.md" (home-folder path)', () => {
      const [anchor] = anchors('@~/x/y.md');
      expect(anchor.properties.dataFilePath).toBe('~/x/y.md');
      expect(anchor.children).toEqual([{ type: 'text', value: '@~/x/y.md' }]);
    });

    it('keeps an "@" that is not the first character (scoped package folders)', () => {
      const [anchor] = anchors('node_modules/@types/node/index.d.ts');
      expect(anchor.properties.dataFilePath).toBe('node_modules/@types/node/index.d.ts');
      expect(anchor.children).toEqual([
        { type: 'text', value: 'node_modules/@types/node/index.d.ts' },
      ]);
    });

    // Chosen trade-off, recorded on purpose: a path that STARTS with a scoped
    // package loses its "@" too. The chat box writes "@path" for files, and a
    // workspace folder whose name starts with "@" is rare.
    it('drops the "@" when the whole text starts with a scoped package', () => {
      expect(linkedPaths('@types/node/index.d.ts')).toEqual(['types/node/index.d.ts']);
    });

    it('does not turn an email address into a file link', () => {
      expect(linkedPaths('write to me@example.com today')).toEqual([]);
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
