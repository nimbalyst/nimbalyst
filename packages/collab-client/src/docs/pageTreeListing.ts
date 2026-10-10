import type { PageTreeNodeSummary } from '@nimbalyst/collab-protocol';

/** Pagination is tied to the visible tree and query, never an authorization token. */
export async function pageTreeListing(
  nodes: PageTreeNodeSummary[],
  scope: string,
  args: Record<string, unknown>,
  rootNodeId: string | null,
): Promise<{ nodes: PageTreeNodeSummary[]; total: number; truncated: boolean; nextCursor: string | null }> {
  const limit = args.limit ?? 100;
  const maxDepth = args.maxDepth;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer from 1 to 500.');
  if (maxDepth !== undefined && (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 100)) throw new Error('maxDepth must be an integer from 0 to 100.');
  const kinds = args.kinds;
  if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.length || kinds.some((kind) => !['page', 'typedPage', 'type'].includes(kind)))) throw new Error('kinds must contain page, typedPage or type.');
  const projection = args.projection ?? 'full';
  if (projection !== 'full' && projection !== 'compact') throw new Error('projection must be full or compact.');
  const rootIndex = rootNodeId ? nodes.findIndex((node) => node.nodeId === rootNodeId) : 0;
  if (rootIndex < 0) throw new Error('The requested subtree is unavailable.');
  const rootDepth = rootNodeId ? nodes[rootIndex].depth : 0;
  let end = nodes.length;
  if (rootNodeId) {
    for (let i = rootIndex + 1; i < nodes.length; i++) {
      if (nodes[i].depth <= rootDepth) { end = i; break; }
    }
  }
  const selected = nodes.slice(rootIndex, end).filter((node) => (maxDepth === undefined || node.depth - rootDepth <= (maxDepth as number))
    && (!Array.isArray(kinds) || kinds.includes(node.kind)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    scope, rootNodeId, maxDepth, kinds ?? null, projection, selected,
  ])));
  const version = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  let offset = 0;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || !/^[a-f0-9]{64}\.[1-9]\d*$/.test(args.cursor)) throw new Error('Invalid cursor. Restart the listing without cursor.');
    const [previous, position] = args.cursor.split('.');
    offset = Number(position);
    if (previous !== version) throw new Error('The tree or query changed; restart the listing without cursor.');
    if (!Number.isSafeInteger(offset) || offset >= selected.length) throw new Error('Invalid cursor position. Restart the listing without cursor.');
  }
  const next = offset + limit;
  const result = selected.slice(offset, next).map((node) => {
    if (projection === 'full') return node;
    const { link: _link, ...compact } = node;
    if (compact.kind === 'type') {
      const { viewLink: _viewLink, ...type } = compact;
      return type;
    }
    return compact;
  });
  return { nodes: result, total: selected.length, truncated: next < selected.length, nextCursor: next < selected.length ? `${version}.${next}` : null };
}
