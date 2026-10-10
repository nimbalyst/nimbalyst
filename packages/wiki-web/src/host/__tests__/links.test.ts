// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LocalPage } from '@nimbalyst/local-wiki';
import { resolveWikiLink } from '../links';

const page = (id: string, path: string, type: string | null = null, trashedAt: number | null = null) =>
  ({ id, path, dir: path.replace(/\.md$/, ''), type, trashedAt }) as LocalPage;

const pages = [
  page('personas', 'Personas.md'),
  page('cmo', 'Personas/CMO.md', 'persona'),
  page('pm', 'Personas/Product manager.md', 'persona'),
  page('arch', 'Architecture.md'),
  page('old', 'Old.md', null, 1000),
];

describe('resolveWikiLink', () => {
  it('resolves a link relative to the linking page, to a page or a typed page', () => {
    expect(resolveWikiLink(pages, 'Personas.md', 'Personas/CMO.md')).toEqual({ kind: 'item', id: 'cmo' });
    expect(resolveWikiLink(pages, 'Personas.md', 'Personas/Product%20manager.md')).toEqual({ kind: 'item', id: 'pm' });
    expect(resolveWikiLink(pages, 'Personas/CMO.md', '../Architecture.md#3-system-context')).toEqual({ kind: 'page', id: 'arch' });
    expect(resolveWikiLink(pages, 'Architecture.md', 'Personas/')).toEqual({ kind: 'page', id: 'personas' });
  });

  it('reports a file outside the wiki, or a trashed page, instead of opening something else', () => {
    expect(resolveWikiLink(pages, 'Personas.md', '../research/Interview%20Guide.md')).toEqual({ kind: 'outside', path: '../research/Interview Guide.md' });
    expect(resolveWikiLink(pages, 'Architecture.md', 'Old.md')).toEqual({ kind: 'outside', path: 'Old.md' });
  });
});
