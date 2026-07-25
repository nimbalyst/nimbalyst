import { describe, expect, it } from 'vitest';
import {
  rehypeAutolinkSessionRefs,
  __test,
} from '../rehypeAutolinkSessionRefs';

const { splitTextNode } = __test;

const KNOWN = '72989f55-3c63-48e3-9abc-0123456789ab';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const known = new Set([KNOWN]);

/** Collect the hrefs `splitTextNode` would turn into anchors. */
function linkedIds(text: string, set = known): string[] {
  const nodes = splitTextNode(text, set);
  if (!nodes) return [];
  return nodes
    .filter((n: any) => n.type === 'element' && n.tagName === 'a')
    .map((n: any) => n.properties.href as string);
}

describe('rehypeAutolinkSessionRefs detection', () => {
  it('links a known session UUID', () => {
    expect(linkedIds(`sent to ${KNOWN} now`)).toEqual([KNOWN]);
  });

  it('does not link an unknown UUID', () => {
    expect(linkedIds(`sent to ${OTHER} now`)).toEqual([]);
  });

  it('links a known UUID case-insensitively, normalizing to the known form', () => {
    expect(linkedIds(`SENT ${KNOWN.toUpperCase()}`)).toEqual([KNOWN]);
  });

  it('preserves surrounding text when splitting', () => {
    const nodes = splitTextNode(`open ${KNOWN} please`, known)!;
    expect(
      nodes.map((n: any) =>
        n.type === 'text' ? n.value : `[${n.properties.href}]`,
      ),
    ).toEqual(['open ', `[${KNOWN}]`, ' please']);
  });
});

describe('rehypeAutolinkSessionRefs tree transform', () => {
  const run = (tree: any, ids = [KNOWN]) => {
    rehypeAutolinkSessionRefs({ sessionIds: ids })(tree);
    return tree;
  };

  it('links a whole-node inline code session id', () => {
    const tree: any = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'code',
          children: [{ type: 'text', value: KNOWN }],
        },
      ],
    };
    run(tree);
    expect(tree.children[0].tagName).toBe('a');
    expect(tree.children[0].properties.href).toBe(KNOWN);
  });

  it('is a no-op when no ids are supplied', () => {
    const tree: any = {
      type: 'root',
      children: [{ type: 'text', value: `ref ${KNOWN}` }],
    };
    run(tree, []);
    expect(tree.children[0].type).toBe('text');
  });
});
