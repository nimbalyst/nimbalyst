// @vitest-environment node
/**
 * `nim wiki <verb>` parses into exactly the Pages tool call a terminal agent
 * would make. Pure: no server, no checkout.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_TOOL_NAMES } from '@nimbalyst/collab-protocol';
import { parseArgs } from '../../cli/parse.js';
import { PAGES_VERBS, pagesToolCall } from '../pages.js';

const call = (...argv: string[]) => pagesToolCall(parseArgs(['wiki', ...argv]));

describe('nim wiki', () => {
  it('has a verb for every Pages tool', () => {
    expect([...new Set(Object.values(PAGES_VERBS))].sort()).toEqual([...PAGE_TOOL_NAMES].sort());
  });

  it('turns each verb into its tool call', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-pages-'));
    const edits = path.join(tmp, 'edits.json');
    fs.writeFileSync(edits, JSON.stringify([{ oldText: 'a', newText: 'b' }]));
    const uri = 'collab://org:o1:doc:d1';
    try {
      expect(call('list')).toEqual({ tool: 'listPages', args: { section: 'team' } });
      expect(call('read', uri)).toEqual({ tool: 'readCollabDoc', args: { filePath: uri } });
      expect(call('edit', uri, '--old', 'x', '--new', 'y', '--old', 'p', '--new', 'q')).toEqual({
        tool: 'applyCollabDocEdit',
        args: { filePath: uri, replacements: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] },
      });
      expect(call('edit', uri, '--replacements-file', edits).args.replacements).toEqual([{ oldText: 'a', newText: 'b' }]);
      expect(call('create', 'Flags', '--parent', 'd0', '--body', '# Flags', '--after', 'document:d9')).toEqual({
        tool: 'createSharedDoc',
        args: { section: 'team', title: 'Flags', parentFolderId: 'd0', initialContent: '# Flags', after: 'document:d9' },
      });
      expect(call('create-folder', 'Area', '--path', 'Architecture/Overview')).toEqual({
        tool: 'createSharedFolder', args: { section: 'team', name: 'Area', folderPath: 'Architecture/Overview' },
      });
      expect(call('move', 'CFS-2', '--kind', 'item', '--under-type')).toEqual({
        tool: 'moveSharedItem', args: { section: 'team', itemId: 'CFS-2', kind: 'item', underType: true },
      });
      expect(call('move', 'd1', '--kind', 'page', '--parent', 'CFS-2', '--parent-kind', 'item', '--before', 'document:d2').args).toEqual({
        section: 'team', itemId: 'd1', kind: 'page', newParentFolderId: 'CFS-2', parentKind: 'item', before: 'document:d2',
      });
      expect(call('rename', 'd1', 'New name')).toEqual({ tool: 'renameSharedItem', args: { section: 'team', itemId: 'd1', newName: 'New name' } });
      expect(call('delete', 'd1', '--kind', 'folder')).toEqual({ tool: 'deleteSharedItem', args: { section: 'team', itemId: 'd1', kind: 'folder' } });
      expect(call('set-type', 'd1', 'technology')).toEqual({ tool: 'setPageType', args: { section: 'team', pageId: 'd1', typeId: 'technology' } });
      expect(call('set-fields', 'd1', '--status', 'current', '--tag', 'a', '--tag', 'b', '--clear', 'owner')).toEqual({
        tool: 'setPageFields', args: { section: 'team', itemId: 'd1', fields: { status: 'current', tags: ['a', 'b'], owner: null } },
      });
      expect(call('members', 'dana')).toEqual({ tool: 'findOrgMembers', args: { query: 'dana' } });
      expect(call('search', 'durable object', '--limit', '5')).toEqual({ tool: 'searchPages', args: { section: 'team', query: 'durable object', limit: 5 } });
      expect(call('types', '--search', 'tech')).toEqual({ tool: 'tracker_list_types', args: { search: 'tech' } });
      expect(call('items', '--type', 'technology', '--where', 'maturity=beta', '--where', 'owner~dana', '--where', 'status=in:a,b', '--include-closed', '--limit', '5')).toEqual({
        tool: 'tracker_list',
        args: {
          type: 'technology', includeClosed: true, limit: 5,
          where: [{ field: 'maturity', op: '=', value: 'beta' }, { field: 'owner', op: 'contains', value: 'dana' }, { field: 'status', op: 'in', value: ['a', 'b'] }],
        },
      });
      expect(call('item', 'CFS-2')).toEqual({ tool: 'tracker_get', args: { id: 'CFS-2' } });
      expect(call('create-item', 'technology', 'Flagship', '--field', 'maturity=beta', '--tag', 'flags', '--body', 'Body')).toEqual({
        tool: 'tracker_create', args: { type: 'technology', title: 'Flagship', fields: { maturity: 'beta' }, tags: ['flags'], description: 'Body' },
      });
      expect(call('update-item', 'CFS-2', '--title', 'T', '--unset', 'owner', '--expected-revision', '4', '--archive')).toEqual({
        tool: 'tracker_update', args: { id: 'CFS-2', title: 'T', unsetFields: ['owner'], expectedRevision: 4, archived: true },
      });
      expect(call('comments', '--page', uri, '--query', 'flags')).toEqual({
        tool: 'list_citable_inputs', args: { kinds: ['comment'], pages: [uri], query: 'flags' },
      });
      expect(call('define-type', '--remove-predicate', 'old', '--confirm-destructive')).toEqual({
        tool: 'tracker_define_type', args: { removePredicates: ['old'], confirmDestructive: true },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses incomplete calls before reaching the server', () => {
    expect(() => call('read')).toThrow(/page uri/);
    expect(() => call('edit', 'collab://x', '--old', 'a')).toThrow(/--old.*--new/);
    expect(() => call('edit', 'collab://x')).toThrow(/--old/);
    expect(() => call('delete', 'd1')).toThrow(/--kind/);
    expect(() => call('update-item', 'CFS-2')).toThrow(/Nothing to update/);
    expect(() => call('comments')).toThrow(/--page/);
    expect(() => call('nope')).toThrow(/Unknown 'nim wiki' subcommand/);
  });
});
