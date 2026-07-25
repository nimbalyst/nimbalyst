import { describe, expect, it } from 'vitest';
import {
  rehypeAutolinkTrackerRefs,
  __test,
} from '../rehypeAutolinkTrackerRefs';

const { buildKeyRegExp, splitTextNode } = __test;

const PREFIXES = ['NIM', 'ENG'];

/** Collect the hrefs `splitTextNode` would turn into anchors. */
function linkedKeys(text: string, prefixes = PREFIXES): string[] {
  const re = buildKeyRegExp(prefixes)!;
  const nodes = splitTextNode(text, re);
  if (!nodes) return [];
  return nodes
    .filter((n: any) => n.type === 'element' && n.tagName === 'a')
    .map((n: any) => n.properties.href as string);
}

describe('rehypeAutolinkTrackerRefs key detection', () => {
  describe('should link (prefix in workspace)', () => {
    const cases: Array<[string, string[]]> = [
      ['NIM-1639', ['nimbalyst://NIM-1639']],
      ['see NIM-1639 and ENG-42 now', ['nimbalyst://NIM-1639', 'nimbalyst://ENG-42']],
      ['(NIM-1)', ['nimbalyst://NIM-1']],
      ['nim-12 lowercase normalizes', ['nimbalyst://NIM-12']],
    ];
    it.each(cases)('links %j', (input, expected) => {
      expect(linkedKeys(input)).toEqual(expected);
    });
  });

  describe('should NOT link', () => {
    const cases: string[] = [
      'UTF-8',
      'COVID-19',
      'ISO-9001',
      'v1-2',
      'xNIM-1',
      'NIM-1x',
      'JIRA-99', // prefix not present in this workspace
      'just prose without keys',
    ];
    it.each(cases)('does not link %j', (input) => {
      expect(linkedKeys(input)).toEqual([]);
    });
  });

  it('returns no matcher when there are no prefixes', () => {
    expect(buildKeyRegExp([])).toBeNull();
  });

  it('preserves surrounding text when splitting', () => {
    const re = buildKeyRegExp(PREFIXES)!;
    const nodes = splitTextNode('fixed NIM-7 today', re)!;
    expect(
      nodes.map((n: any) =>
        n.type === 'text' ? n.value : `[${n.properties.href}]`,
      ),
    ).toEqual(['fixed ', '[nimbalyst://NIM-7]', ' today']);
  });
});

describe('rehypeAutolinkTrackerRefs tree transform', () => {
  const run = (tree: any, prefixes = PREFIXES) => {
    rehypeAutolinkTrackerRefs({ prefixes })(tree);
    return tree;
  };

  it('links a whole-node inline code key', () => {
    const tree: any = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'code',
          children: [{ type: 'text', value: 'NIM-123' }],
        },
      ],
    };
    run(tree);
    const node = tree.children[0];
    expect(node.tagName).toBe('a');
    expect(node.properties.href).toBe('nimbalyst://NIM-123');
  });

  it('leaves a key embedded in larger inline code untouched', () => {
    const tree: any = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'code',
          children: [{ type: 'text', value: 'run NIM-123 now' }],
        },
      ],
    };
    run(tree);
    expect(tree.children[0].tagName).toBe('code');
  });

  it('does not descend into fenced code (<pre>) or existing links (<a>)', () => {
    const tree: any = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'pre',
          children: [
            {
              type: 'element',
              tagName: 'code',
              children: [{ type: 'text', value: 'NIM-123' }],
            },
          ],
        },
        {
          type: 'element',
          tagName: 'a',
          properties: { href: 'nimbalyst://NIM-9' },
          children: [{ type: 'text', value: 'NIM-9' }],
        },
      ],
    };
    run(tree);
    // <pre> subtree untouched: inner code still a code node
    expect(tree.children[0].children[0].tagName).toBe('code');
    // existing <a> untouched: single text child, not re-wrapped
    expect(tree.children[1].children).toHaveLength(1);
    expect(tree.children[1].children[0].type).toBe('text');
  });

  it('is a no-op when no prefixes are supplied', () => {
    const tree: any = {
      type: 'root',
      children: [{ type: 'text', value: 'NIM-1' }],
    };
    run(tree, []);
    expect(tree.children[0].type).toBe('text');
  });
});
