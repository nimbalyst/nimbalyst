// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import { buildCollabTypeResolver } from '../collabTypeResolver';
import { buildCollabPageTree } from '../collabPageTree';
import type { CollabTreeDocumentNode, CollabTreeTypeNode } from '../collabTree';

const model = (type: string, sharing: 'team' | 'personal'): TrackerDataModel =>
  ({ type, displayName: type, displayNamePlural: `${type}s`, icon: 'table', sharing }) as unknown as TrackerDataModel;

describe('buildCollabTypeResolver', () => {
  it('offers and names only team-shared types, so a teammate never gets a placement they cannot resolve', () => {
    const models = [model('module', 'team'), model('scratch', 'personal')];
    const resolver = buildCollabTypeResolver(
      { get: (type) => models.find((candidate) => candidate.type === type), getListed: () => models },
      [],
    );

    expect(resolver.listedTypes?.().map((type) => type.typeId)).toEqual(['module']);
    expect(resolver.typeName('module')).toBe('modules');
    expect(resolver.typeName('scratch')).toBeNull();
  });

  it('offers only personal types, with their items, in the personal lane', () => {
    const models = [model('module', 'team'), model('scratch', 'personal')];
    const records = [
      { id: 'r1', typeId: 'scratch', title: 'Idea' },
      { id: 'r2', typeId: 'module', title: 'Sync' },
    ];
    const resolver = buildCollabTypeResolver(
      { get: (type) => models.find((candidate) => candidate.type === type), getListed: () => models },
      records,
      'personal',
    );

    expect(resolver.listedTypes?.().map((type) => type.typeId)).toEqual(['scratch']);
    expect(resolver.typeName('module')).toBeNull();
    expect(resolver.itemsOfType('scratch').map((item) => item.itemId)).toEqual(['r1']);
    expect(resolver.itemsOfType('module')).toEqual([]);
    // A placed typed page resolves only in its own lane, with the singular type name.
    expect(resolver.item?.('r1')).toEqual({ itemId: 'r1', title: 'Idea', typeId: 'scratch' });
    expect(resolver.item?.('r2')).toBeNull();
    expect(resolver.typeLabel?.('scratch')).toBe('scratch');
  });

  it('keeps an item that exists only on this machine out of the team section, even under a team type', () => {
    const models = [model('decision', 'team')];
    const resolver = buildCollabTypeResolver(
      { get: (type) => models.find((candidate) => candidate.type === type), getListed: () => models },
      [
        { id: 'dec_1', typeId: 'decision', title: 'Shared', issueNumber: 1 },
        // A frontmatter projection of a local file, never shared.
        { id: 'fm:decision:temptests/wiki/decision/second.md', typeId: 'decision', title: 'Second', localOnly: true },
      ],
    );
    expect(resolver.itemsOfType('decision').map((item) => item.itemId)).toEqual(['dec_1']);
    expect(resolver.item?.('fm:decision:temptests/wiki/decision/second.md')).toBeNull();
  });

  it('keeps a type whose file did not load in the page tree, marked broken, with its table and typed pages (NIM-7437)', () => {
    const models = [model('scratch', 'personal')];
    const registry = { get: (type: string) => models.find((candidate) => candidate.type === type), getListed: () => models };
    const records = [
      { id: 'row-1', typeId: 'lesson', title: 'Read the diff' },
      { id: 'pg-1', typeId: 'guide', title: 'Onboarding' },
    ];
    const broken = new Map([['lesson', 'Missing required field: modes'], ['guide', 'Missing required field: modes'], ['scratch', 'stale']]);
    const at = { projectId: null, sortOrder: 0, createdBy: 'u', createdAt: 1, updatedAt: 1 };
    const page = { documentId: 'how', teamProjectId: null, title: 'How I work', documentType: 'markdown', createdBy: 'u', createdAt: 1, updatedAt: 1, parentFolderId: null };
    const tree = buildCollabPageTree([page], {
      resolver: buildCollabTypeResolver(registry, records, 'personal', broken),
      typePlacements: [{ typeId: 'lesson', parentFolderId: 'how', ...at }],
      itemPlacements: [{ itemId: 'pg-1', parentId: 'how', ...at }],
    });
    const children = (tree[0] as CollabTreeDocumentNode).children ?? [];
    const table = children.find((node) => node.id === 'type:lesson') as CollabTreeTypeNode;
    expect(table).toMatchObject({ name: 'lesson', error: 'Missing required field: modes', count: 1 });
    expect(table.children).toEqual([expect.objectContaining({ itemId: 'row-1', typeError: 'Missing required field: modes' })]);
    expect(children.find((node) => node.id === 'item:pg-1')).toMatchObject({ typeLabel: 'guide', typeError: 'Missing required field: modes' });

    // Without the broken list both vanish, which is the bug.
    const silent = buildCollabPageTree([page], {
      resolver: buildCollabTypeResolver(registry, records, 'personal'),
      typePlacements: [{ typeId: 'lesson', parentFolderId: 'how', ...at }],
      itemPlacements: [{ itemId: 'pg-1', parentId: 'how', ...at }],
    });
    expect((silent[0] as CollabTreeDocumentNode).children ?? []).toEqual([]);
    // A loaded type is never marked broken: a bad edit keeps its last good definition.
    expect(buildCollabTypeResolver(registry, records, 'personal', broken).typeError?.('scratch')).toBeNull();
  });

  it('marks types that take no new pages, so Set type can leave them out', () => {
    const models = [model('module', 'team'), { ...model('ledger', 'team'), creatable: false } as TrackerDataModel];
    const resolver = buildCollabTypeResolver({ get: (type) => models.find((candidate) => candidate.type === type), getListed: () => models }, []);
    expect(resolver.listedTypes?.().map((type) => [type.typeId, type.creatable])).toEqual([['module', undefined], ['ledger', false]]);
  });
});
