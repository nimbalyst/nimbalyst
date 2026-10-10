// @vitest-environment node
/**
 * Shared format fixtures (`packages/local-wiki/fixtures/<case>/`). Each case's
 * `expected.json` is what this library reads from `wiki/` with the types in
 * `trackers/`; the Swift and Kotlin readers test against the same files. This
 * test keeps `expected.json` from drifting: run with UPDATE_WIKI_FIXTURES=1 to
 * rewrite it after an intended format change.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWiki, type PageRecord, type ScanState } from '../scan.js';
import { loadTypeDefs, type WikiTypeDef } from '../typeDefs.js';
import { DEFAULT_EDITOR_TYPES, normalizeEditorTypes } from '../sidecar.js';
import { decodeRow } from '../tableCodec.js';
import { nameKey } from '../names.js';
import yaml from 'js-yaml';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const CONFLICT_COPY = / \(conflict [^)]*\)$/i;

type Node =
  | {
      kind: 'page';
      id: string;
      title: string;
      path: string | null;
      dir: string;
      type: string | null;
      order: number | null;
      documentType: string;
      fields: Record<string, unknown>;
      conflictOf?: string;
      children: Node[];
    }
  | {
      kind: 'table';
      typeId: string;
      title: string;
      path: string;
      header: string[];
      rows: Array<{ id: string; title: string; fields: Record<string, unknown> }>;
    };

/**
 * Siblings: explicit order first, then unordered by title (as project.ts
 * `effectiveOrders`). Equal orders (a conflict copy keeps its original's) fall
 * back to the title so every reader breaks the tie the same way.
 */
function sortSiblings<T extends { order: number | null; title: string }>(items: T[]): T[] {
  const byTitle = (a: T, b: T) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  return [...items].sort((a, b) => {
    if (a.order !== null && b.order !== null) return a.order - b.order || byTitle(a, b);
    if (a.order !== null) return -1;
    if (b.order !== null) return 1;
    return byTitle(a, b);
  });
}

function conflictOriginal(page: PageRecord, siblings: PageRecord[]): string | undefined {
  if (!page.path || !CONFLICT_COPY.test(page.stem)) return undefined;
  const stem = page.stem.replace(CONFLICT_COPY, '');
  return siblings.find((s) => s !== page && nameKey(s.stem) === nameKey(stem))?.id;
}

function buildTree(state: ScanState, types: Map<string, WikiTypeDef>, tableOrders: Record<string, number>): Node[] {
  const pages = [...state.pages.values()];
  const build = (parentId: string | null, parentDir: string): Node[] => {
    const siblings = pages.filter((p) => p.parentId === parentId);
    const entries: Array<{ order: number | null; title: string; node: () => Node }> = siblings.map((page) => ({
      order: page.order,
      title: page.title,
      node: () => ({
        kind: 'page',
        id: page.id,
        title: page.title,
        path: page.path,
        dir: page.dir,
        type: page.type,
        order: page.order,
        documentType: page.documentType,
        fields: page.fields,
        ...(conflictOriginal(page, siblings) ? { conflictOf: conflictOriginal(page, siblings) } : {}),
        children: build(page.id, page.dir),
      }),
    }));
    for (const table of state.tables.values()) {
      if (nameKey(table.parentDir) !== nameKey(parentDir)) continue;
      const def = types.get(table.typeId)!;
      entries.push({
        order: tableOrders[table.typeId] ?? null,
        title: table.typeId,
        node: () => ({
          kind: 'table',
          typeId: table.typeId,
          title: def.displayNamePlural,
          path: table.path,
          header: table.header,
          rows: table.rows.map((row) => {
            const decoded = decodeRow(table.header, row, def);
            const title = decoded.fields[def.titleField];
            return { id: decoded.id, title: typeof title === 'string' ? title : '', fields: decoded.fields };
          }),
        }),
      });
    }
    return sortSiblings(entries).map((e) => e.node());
  };
  return build(null, '');
}

async function readCase(name: string) {
  const root = path.join(FIXTURES, name, 'wiki');
  const { types } = await loadTypeDefs(path.join(FIXTURES, name, 'trackers'));
  const marker = yaml.load(readFileSync(path.join(root, '.nimbalyst-wiki.yaml'), 'utf8'), { schema: yaml.CORE_SCHEMA }) as {
    formatVersion: number;
    tables?: Record<string, { order?: number }>;
  };
  const tableOrders: Record<string, number> = {};
  for (const [typeId, entry] of Object.entries(marker.tables ?? {})) if (typeof entry?.order === 'number') tableOrders[typeId] = entry.order;
  const state = await scanWiki({
    root,
    types,
    editorTypes: normalizeEditorTypes(DEFAULT_EDITOR_TYPES),
    repair: false,
    cache: new Map(),
    now: 0,
    duplicates: new Map(),
    duplicateGraceMs: 60_000,
  });
  const links = [...state.pages.values()]
    .flatMap((page) =>
      page.links.map((link, ordinal) => ({ from: page.id, ordinal, path: link.path, fragment: link.fragment, id: link.id, target: page.linkTargets[ordinal] })),
    )
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.ordinal - b.ordinal));
  return {
    formatVersion: marker.formatVersion,
    // The wiki types as a reader without the YAML files receives them.
    types: [...types.values()]
      .filter((t) => t.wikiType)
      .map(({ sourcePath: _s, wikiType: _w, ...rest }) => rest)
      .sort((a, b) => (a.typeId < b.typeId ? -1 : 1)),
    tree: buildTree(state, types, tableOrders),
    links,
    trashedIds: [...state.trash.keys()].sort(),
  };
}

const cases = readdirSync(FIXTURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

describe('local wiki fixtures', () => {
  it.each(cases)('%s matches expected.json', async (name) => {
    const actual = JSON.parse(JSON.stringify(await readCase(name)));
    const file = path.join(FIXTURES, name, 'expected.json');
    if (process.env.UPDATE_WIKI_FIXTURES) writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });
});
