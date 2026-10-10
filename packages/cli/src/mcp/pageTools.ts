/**
 * Page tools over the local wiki, under the shared contract's names
 * (`pageToolContract.ts`), so the wiki skills read the same here as against the
 * desktop app and the remote server. Every call opens the wiki fresh; see
 * localTools.ts for the plumbing.
 */
import type { LocalPage, LocalWiki } from '@nimbalyst/local-wiki';
import { orderBetween } from '@nimbalyst/local-wiki';
import { usageError } from '../cli/exitCodes.js';
import { buildTree, findPage, livePages, localPageUri, positionBeside, type TreeNode } from '../localWiki/tree.js';
import { applyReplacements, ensureFolderPath, type Replacement } from '../localWiki/writes.js';
import { contractDefinition, localTool, requireStr, str, type Args, type LocalWikiContext } from './localTools.js';
import type { McpTool } from './toolMap.js';

const PAGE_REFS = ['filePath', 'itemId', 'pageId', 'parentFolderId', 'newParentFolderId', 'before', 'after', 'root'];

const stripNodePrefix = (ref: string) => ref.replace(/^(document|item|page):/, '');

async function resolveParent(wiki: LocalWiki, args: Args, idKey: string): Promise<string | null> {
  const folderPath = str(args, 'folderPath');
  if (folderPath) return ensureFolderPath(wiki, folderPath);
  const parentRef = str(args, idKey);
  return parentRef ? findPage(await wiki.snapshot(), stripNodePrefix(parentRef)).id : null;
}

/** The new page's parent and order: beside a sibling when `before`/`after` is given, else last under the parent. */
async function placement(wiki: LocalWiki, args: Args, idKey: string, movingId?: string) {
  const before = str(args, 'before');
  const after = str(args, 'after');
  if (before && after) throw usageError('Pass before or after, not both');
  if (before || after) return positionBeside(await wiki.snapshot(), (before ?? after)!, before ? 'before' : 'after', movingId);
  return { parentId: await resolveParent(wiki, args, idKey), sortOrder: undefined };
}

function pageSummary(page: LocalPage) {
  return { id: page.id, title: page.title, type: page.type, documentType: page.documentType, uri: localPageUri(page.id), path: page.path };
}

function subtree(nodes: TreeNode[], rootRef: string): TreeNode[] {
  const ref = stripNodePrefix(rootRef.replace(/^type:/, ''));
  const at = nodes.findIndex((n) => n.nodeId === rootRef || n.id === ref || n.path === ref);
  if (at < 0) throw usageError(`No node "${rootRef}" in the local wiki`);
  const rootDepth = nodes[at].depth;
  let end = at + 1;
  while (end < nodes.length && nodes[end].depth > rootDepth) end++;
  return nodes.slice(at, end).map((n) => ({ ...n, depth: n.depth - rootDepth }));
}

export function pageTools(context: LocalWikiContext): McpTool[] {
  return [
    localTool(
      contractDefinition(
        'listPages',
        "List the local wiki's pages as a tree: plain pages, typed pages and table types, depth-first in display order (100 nodes per call by default, at most 500; pass nextCursor until truncated is false). Each node has nodeId, kind, id, title, parentNodeId, depth, sortOrder, childCount and, for pages, the uri to read and edit the body and the file path. Pages are files in the wiki folder: markdown, or an editor file (drawing, mind map, data model, spreadsheet...) whose node carries its documentType.",
      ),
      context,
      async ({ wiki, dir }, args) => {
        let nodes: Array<Partial<TreeNode> & Pick<TreeNode, 'nodeId' | 'id' | 'depth' | 'kind'>> = buildTree(await wiki.snapshot());
        const root = str(args, 'root');
        if (root) nodes = subtree(buildTree(await wiki.snapshot()), root);
        if (typeof args.maxDepth === 'number') nodes = nodes.filter((n) => n.depth <= (args.maxDepth as number));
        if (Array.isArray(args.kinds) && args.kinds.length) nodes = nodes.filter((n) => (args.kinds as string[]).includes(n.kind));
        if (args.projection === 'compact') nodes = nodes.map(({ uri: _uri, path: _path, fields: _fields, ...rest }) => rest);
        const limit = Math.min(Math.max(typeof args.limit === 'number' ? Math.floor(args.limit) : 100, 1), 500);
        const offset = str(args, 'cursor') ? Number.parseInt(str(args, 'cursor')!, 10) || 0 : 0;
        const page = nodes.slice(offset, offset + limit);
        const truncated = offset + limit < nodes.length;
        return { wikiFolder: dir, nodes: page, total: nodes.length, truncated, ...(truncated ? { nextCursor: String(offset + limit) } : {}) };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition(
        'searchPages',
        "Search the local wiki's pages and table rows by title, body and field text. Every word must match; title matches rank first. Returns kind, id, title, type, the uri to read with readCollabDoc, the file path and a snippet.",
      ),
      context,
      async ({ wiki }, args) => {
        const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50);
        const hits = await wiki.search(requireStr(args, 'query'), { limit });
        return {
          results: hits.map((hit) => ({
            kind: hit.kind === 'row' || hit.type ? 'typedPage' : 'page',
            id: hit.id,
            title: hit.title,
            type: hit.type,
            ...(hit.kind === 'page' ? { uri: localPageUri(hit.id) } : {}),
            path: hit.path,
            snippet: hit.snippet,
          })),
        };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition('readCollabDoc', "Read a local wiki page's body, with its fields and the version to pass to applyCollabDocEdit. A markdown page's body is its markdown without frontmatter; an editor page's (documentType excalidraw, mindmap, csv...) is its whole file text, in `markdown`.", {
        drop: ['includeDecisionState'],
      }),
      context,
      async ({ wiki }, args) => {
        const page = findPage(await wiki.snapshot(), requireStr(args, 'filePath'));
        const body = await wiki.readBody(page.id);
        return { ...pageSummary(page), fields: page.fields, version: body.version, markdown: body.markdown };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition(
        'applyCollabDocEdit',
        "Edit a local wiki page's body: exact text replacements (each oldText must be found; a miss fails the whole call), or `content` to replace the whole body. Pass `expectedVersion` from readCollabDoc to refuse the edit if the file changed since you read it.",
        {
          extra: {
            content: { type: 'string', description: 'Local wiki only: the new body, replacing all of it. Use instead of replacements.' },
            expectedVersion: { type: 'string', description: 'Local wiki only: the version from readCollabDoc.' },
          },
        },
      ),
      context,
      async ({ wiki }, args) => {
        const page = findPage(await wiki.snapshot(), requireStr(args, 'filePath'));
        const current = await wiki.readBody(page.id);
        const expected = str(args, 'expectedVersion') ?? current.version;
        let next: string;
        if (typeof args.content === 'string') {
          if (Array.isArray(args.replacements) && args.replacements.length) throw usageError('Pass content or replacements, not both');
          next = args.content;
        } else {
          if (!Array.isArray(args.replacements) || args.replacements.length === 0) throw usageError('Pass replacements or content');
          next = applyReplacements(current.markdown, args.replacements as Replacement[]);
        }
        const result = await wiki.writeBody(page.id, next, expected);
        if (!result.ok) {
          throw usageError(`the page changed since version ${expected} (now ${result.currentVersion}); nothing was written. Read it again and redo the edit.`);
        }
        return { ...pageSummary(page), version: result.version };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition(
        'createSharedDoc',
        'Create a local wiki page, at the top of the wiki, under a page (parentFolderId), under a path of titles (folderPath, missing pages are created), or beside a sibling (before/after). A markdown page by default; documentType (excalidraw, mindmap, datamodel, mockup.html, csv...) makes an editor file, whose initialContent is the whole file. Returns documentId, uri and path.',
      ),
      context,
      async ({ wiki }, args) => {
        const documentType = str(args, 'documentType') ?? 'markdown';
        if (documentType === 'code') throw usageError('A local wiki page cannot be a code file.');
        const where = await placement(wiki, args, 'parentFolderId');
        const created = await wiki.command({
          type: 'register-document',
          title: requireStr(args, 'title'),
          parentFolderId: where.parentId,
          sortOrder: where.sortOrder,
          body: typeof args.initialContent === 'string' ? args.initialContent : '',
          ...(documentType !== 'markdown' ? { documentType } : {}),
        });
        const page = findPage(await wiki.snapshot(), created.id!);
        return { documentId: page.id, uri: localPageUri(page.id), path: page.path };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition('createSharedFolder', 'Create an empty local wiki page to hold child pages. Returns its page id as folderId.'),
      context,
      async ({ wiki }, args) => {
        const parentId = await resolveParent(wiki, args, 'parentFolderId');
        const created = await wiki.command({ type: 'register-document', title: requireStr(args, 'name'), parentFolderId: parentId });
        return { folderId: created.id, uri: localPageUri(created.id!) };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition(
        'moveSharedItem',
        "Move or reorder a node in the local wiki: a page or typed page (kind 'doc', 'folder', 'page' or 'item') under a new parent, under a path of titles, or before/after a sibling; or a table type ('type') under a page. The page's file, child folder and links move with it. Refuses a move into itself.",
      ),
      context,
      async ({ wiki }, args) => {
        const kind = requireStr(args, 'kind');
        const itemRef = stripNodePrefix(requireStr(args, 'itemId'));
        if (args.underType) throw usageError('Local typed pages are not filed under their type; give a parent page or omit it for the top of the wiki.');
        if (kind === 'type') {
          const typeId = itemRef.replace(/^type:/, '');
          const parentId = await resolveParent(wiki, args, 'newParentFolderId');
          const snapshot = await wiki.snapshot();
          const last = livePages(snapshot)
            .filter((p) => (p.parentId ?? null) === parentId)
            .reduce<number | null>((max, p) => (p.order !== null && (max === null || p.order > max) ? p.order : max), null);
          await wiki.command({ type: 'set-type-placement', typeId, parentFolderId: parentId, sortOrder: orderBetween(last, null) });
          return { typeId, parentId };
        }
        const page = findPage(await wiki.snapshot(), itemRef);
        const where = await placement(wiki, args, 'newParentFolderId', page.id);
        await wiki.command({ type: 'move-document', documentId: page.id, parentFolderId: where.parentId, sortOrder: where.sortOrder });
        return pageSummary(findPage(await wiki.snapshot(), page.id));
      },
      { refKeys: PAGE_REFS, issueKeys: ['itemId'] },
    ),
    localTool(
      contractDefinition('renameSharedItem', "Rename a local wiki page. The file name follows the title; links to it are updated."),
      context,
      async ({ wiki }, args) => {
        const page = findPage(await wiki.snapshot(), stripNodePrefix(requireStr(args, 'itemId')));
        await wiki.command({ type: 'update-document-title', documentId: page.id, title: requireStr(args, 'newName') });
        return pageSummary(findPage(await wiki.snapshot(), page.id));
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition(
        'deleteSharedItem',
        "Move a local wiki page to the wiki's trash (.trash/ in the folder), where it can be restored. kind 'folder' takes the page with everything under it; kind 'doc' only a page with no children. Ask a person before deleting a page someone else wrote.",
      ),
      context,
      async ({ wiki }, args) => {
        const snapshot = await wiki.snapshot();
        const page = findPage(snapshot, stripNodePrefix(requireStr(args, 'itemId')));
        const kind = requireStr(args, 'kind');
        const children = livePages(snapshot).filter((p) => p.parentId === page.id).length;
        if (kind === 'doc' && children > 0) {
          throw usageError(`"${page.title}" has ${children} child page(s); use kind 'folder' to move it to trash with them`);
        }
        await wiki.command({ type: 'trash-document', documentId: page.id });
        return { trashed: page.id, title: page.title, children };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition(
        'setPageType',
        "Give a local wiki page a type: it becomes a typed page of that type in place (same file, id, body and children; `type` is set in its frontmatter). Returns the item id, which is the page id.",
      ),
      context,
      async ({ wiki }, args) => {
        const page = findPage(await wiki.snapshot(), requireStr(args, 'pageId'));
        const typeId = requireStr(args, 'typeId');
        await wiki.command({ type: 'set-document-type', documentId: page.id, pageType: typeId });
        return { itemId: page.id, type: typeId };
      },
      { refKeys: PAGE_REFS },
    ),
    localTool(
      contractDefinition(
        'setPageFields',
        "Set a local wiki page's own fields: owner, status (draft, current or outdated), summary (one line, at most 280 characters) and tags. Only the fields you pass change; null clears one. A value that does not fit is ignored, and the reply names the fields the page has now. A typed page's fields are set with tracker_update.",
      ),
      context,
      async ({ wiki }, args) => {
        const page = findPage(await wiki.snapshot(), stripNodePrefix(requireStr(args, 'itemId')));
        const input = (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        const ignored: string[] = [];
        for (const [key, value] of Object.entries(input)) {
          const fits =
            value === null ||
            (key === 'owner' && typeof value === 'string') ||
            (key === 'status' && ['draft', 'current', 'outdated'].includes(value as string)) ||
            (key === 'summary' && typeof value === 'string' && value.length <= 280 && !value.includes('\n')) ||
            (key === 'tags' && Array.isArray(value) && value.every((t) => typeof t === 'string'));
          if (fits && ['owner', 'status', 'summary', 'tags'].includes(key)) patch[key] = value;
          else ignored.push(key);
        }
        if (Object.keys(patch).length) await wiki.command({ type: 'set-document-fields', documentId: page.id, fields: patch });
        const now = findPage(await wiki.snapshot(), page.id);
        return { itemId: page.id, fields: now.fields, ...(ignored.length ? { ignored } : {}) };
      },
      { refKeys: PAGE_REFS },
    ),
  ];
}
