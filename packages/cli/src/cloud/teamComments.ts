/**
 * Comment threads on a team page, read from the page's Y.Doc, with each
 * thread's anchor state worked out the way the editor does it.
 *
 * Threads live in the top-level array `comments` (`YDocCommentRepository.ts`
 * in the runtime): maps with `type: 'thread'`, `id`, `quote`, `resolved`, an
 * optional `anchor` and a nested `comments` array. The body is the Lexical
 * tree under the top-level `root` XmlText; a comment mark is an element whose
 * `__type` is `mark` and whose `__ids` names the threads it anchors.
 *
 * Anchor state, for a mark-anchored thread and a quote-anchored one alike:
 * `marked` when a mark names the thread, else `quote` when its selector (the
 * `text-quote` anchor with its prefix and suffix, or `{ exact: quote }` for a
 * thread with no anchor) matches exactly once in the page text, else
 * `orphaned`, where "matches" is the editor's `findThreadQuoteOffset`: the
 * full selector, else the bare quote when it occurs exactly once (the quote's
 * neighbours were edited). An `entity` anchor is never matched against text; it is
 * reported as `entity`. The page text and the matching are the editor's own
 * (`quoteMatch.ts` in the runtime): one block per child of `root`, the text
 * of every text node under it with nothing between, blocks joined by
 * `joinCommentTextBlocks`.
 *
 * The doc comes from the editors' bundle, which has its own copy of yjs; nim
 * bundles none. The top-level types may not have been given a class there
 * (nothing in nim calls `doc.get(name, Class)`), so they are walked through
 * their item list, which every yjs type has. Nested types are real instances.
 */
import { findThreadQuoteOffset, joinCommentTextBlocks } from '@nimbalyst/runtime/editor/commenting/quoteMatch';

export type AnchorState = 'marked' | 'quote' | 'orphaned' | 'entity';

export interface ThreadComment {
  id: string;
  author: string;
  /** Epoch ms. */
  at: number;
  content: string;
  byAgent: boolean;
}

export interface PageThread {
  id: string;
  quote: string;
  resolved: boolean;
  anchorKind: 'mark' | 'text-quote' | 'entity' | 'unknown';
  anchorState: AnchorState;
  comments: ThreadComment[];
}

export interface PageComments {
  threads: PageThread[];
  /** The body's plain text, as the quote match sees it. */
  text: string;
}

type Item = { right: Item | null; deleted: boolean; content: any };

/** Live item contents of a yjs type, in order. */
function* contents(type: any): Generator<any> {
  for (let item: Item | null = type?._start ?? null; item; item = item.right) {
    if (!item.deleted) yield item.content;
  }
}

/** An array type's values, typed or not (class names do not survive the bundle's minifier). */
function arrayValues(type: any): unknown[] {
  if (!type) return [];
  const out: unknown[] = [];
  for (const content of contents(type)) {
    if (typeof content?.getContent === 'function') out.push(...content.getContent());
  }
  return out;
}

/** Every text node's text under an element, in order, with nothing between. */
function textUnder(element: any): string {
  let text = '';
  for (const content of contents(element)) {
    if (typeof content?.str === 'string') text += content.str;
    else if (typeof content?.type?.getAttribute === 'function') text += textUnder(content.type);
  }
  return text;
}

/** The thread ids marks name, anywhere under `element`. */
function collectMarkIds(element: any, into: Set<string>): void {
  for (const content of contents(element)) {
    const child = content?.type;
    // A text node's properties ride in a map before its string; only elements (XmlText) carry children.
    if (!child || typeof child.getAttribute !== 'function') continue;
    if (child.getAttribute('__type') === 'mark') {
      const ids = child.getAttribute('__ids');
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') into.add(id);
    }
    collectMarkIds(child, into);
  }
}

/** The page text as the editor matches quotes in it, and the thread ids marks name, from the Lexical tree. */
export function readLexicalBody(root: any): { text: string; markIds: Set<string> } {
  const blocks: string[] = [];
  for (const content of contents(root)) {
    const child = content?.type;
    if (child && typeof child.getAttribute === 'function') blocks.push(textUnder(child));
  }
  const markIds = new Set<string>();
  collectMarkIds(root, markIds);
  return { text: joinCommentTextBlocks(blocks), markIds };
}

/** Whether the thread's quote is found, by the editor's own rule (context first, then the bare quote when unique). */
function quoteFound(text: string, selector: { exact: string; prefix?: string; suffix?: string }): boolean {
  if (!selector.exact) return false;
  try {
    return findThreadQuoteOffset(text, selector) !== null;
  } catch {
    return false;
  }
}

const get = (map: any, key: string): unknown => (typeof map?.get === 'function' ? map.get(key) : undefined);

function anchorOf(thread: any): { kind: PageThread['anchorKind']; exact?: string; prefix?: string; suffix?: string } {
  const anchor = get(thread, 'anchor') as Record<string, unknown> | undefined;
  if (anchor === undefined || anchor === null) return { kind: 'mark' };
  if (anchor.kind === 'text-quote' && typeof anchor.exact === 'string') {
    return {
      kind: 'text-quote',
      exact: anchor.exact,
      ...(typeof anchor.prefix === 'string' ? { prefix: anchor.prefix } : {}),
      ...(typeof anchor.suffix === 'string' ? { suffix: anchor.suffix } : {}),
    };
  }
  if (anchor.kind === 'entity') return { kind: 'entity' };
  return { kind: 'unknown' };
}

function commentOf(map: any): ThreadComment | null {
  if (get(map, 'deleted') === true) return null;
  const id = get(map, 'id');
  const content = get(map, 'content');
  const at = get(map, 'timeStamp');
  if (typeof id !== 'string' || typeof content !== 'string') return null;
  const actor = get(map, 'actor') as { kind?: unknown; displayName?: unknown; sessionName?: unknown } | undefined;
  const author = typeof actor?.displayName === 'string' && actor.displayName.trim()
    ? actor.displayName.trim()
    : typeof get(map, 'author') === 'string' ? String(get(map, 'author')) : 'unknown';
  return { id, author, at: typeof at === 'number' ? at : 0, content, byAgent: actor?.kind === 'agent' };
}

/** Every thread on the page in `doc`, with its anchor state. */
export function readPageComments(doc: any): PageComments {
  const share: Map<string, unknown> | undefined = doc?.share;
  const { text, markIds } = readLexicalBody(share?.get('root'));
  const threads: PageThread[] = [];
  for (const entry of arrayValues(share?.get('comments'))) {
    if (get(entry, 'type') !== 'thread') continue;
    const id = get(entry, 'id');
    if (typeof id !== 'string') continue;
    const quote = typeof get(entry, 'quote') === 'string' ? String(get(entry, 'quote')) : '';
    const anchor = anchorOf(entry);
    let anchorState: AnchorState;
    if (anchor.kind === 'entity') anchorState = 'entity';
    else if (markIds.has(id)) anchorState = 'marked';
    else {
      const selector = anchor.kind === 'text-quote' ? { exact: anchor.exact!, prefix: anchor.prefix, suffix: anchor.suffix } : { exact: quote };
      anchorState = quoteFound(text, selector) ? 'quote' : 'orphaned';
    }
    const comments = arrayValues(get(entry, 'comments')).map(commentOf).filter((c): c is ThreadComment => c !== null);
    threads.push({ id, quote: anchor.exact ?? quote, resolved: get(entry, 'resolved') === true, anchorKind: anchor.kind, anchorState, comments });
  }
  return { threads, text };
}

/** Open threads someone still has something to say on: not resolved, with a comment left. */
export function openThreads(page: PageComments): PageThread[] {
  return page.threads.filter((thread) => !thread.resolved && thread.comments.length > 0);
}
