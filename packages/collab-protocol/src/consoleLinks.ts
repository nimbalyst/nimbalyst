/**
 * Console links: the https URLs page content uses to point at a page, a typed
 * page, a type, a placed view or a human citation.
 *
 *   team scope   https://console.nimbalyst.com/org/<orgId>/project/<teamProjectId>/document/<documentId>
 *                                                                              /document/<documentId>?comment=<commentId>
 *                                                                              /page/item/<KEY or itemId>
 *                                                                              /page/type/<typeId>
 *                                                                              /view/type/<typeId>
 *                                                                              /view/marks[?kind=decided|open]
 *   local scope  https://console.nimbalyst.com/app/page/<personalPageId>
 *                                              /app/item/<KEY or itemId>
 *                                              /app/type/<typeId>
 *                                              /app/view/...            (same view tail as above)
 *                                              /app/cite/<sessionId>/<prompt|answer|comment>/<key>
 *                                              /app/cite/claude-code/<ccSessionId>/<prompt|answer>/<key>
 *
 * Team links are the console's Pages routes (`document`, `page/item`,
 * `page/type`), so a teammate's browser lands on the real thing. Links written
 * before typed pages had Pages routes (`trackers/item`, `trackers/type`) still
 * parse to the same targets; nothing builds them any more. Local
 * links name things only one person's desktop holds (Personal pages, sessions,
 * personal typed pages); they carry opaque ids, never a filesystem or
 * workspace path, and the console answers them with an "Open in Nimbalyst"
 * page that hands the same path to the app as `nimbalyst://console/...`.
 *
 * A citation of a comment on a team page (`?comment=`) is its own target, not
 * a page link: the console opens the page at the thread, and the page links
 * index does not count it as a reference to the page.
 *
 * A placed view's definition (`cols=`, `sort=`, ...) and a citation's snapshot
 * (`by=`, `quote=`, ...) stay in the markdown link title; only the target is
 * in the URL. Every builder output is safe as a markdown link destination: ids
 * are percent-encoded, including `(`, `)` and `'`.
 *
 * Pure and dependency-free: imported by the runtime editor, the desktop main
 * process and the web console.
 */

export const CONSOLE_LINK_ORIGIN = 'https://console.nimbalyst.com';

/** A team project as the console addresses it: org id and team project id. */
export interface ConsoleTeamScope {
  orgId: string;
  /** The team project id (`teamProjectId`), not the git remote hash. */
  projectId: string;
}

/** `'local'`: something only the author's devices hold. */
export type ConsoleLinkScope = ConsoleTeamScope | 'local';

export type ConsoleViewMarksKind = 'decided' | 'open' | 'all';

export type ConsoleViewTarget =
  | { kind: 'type'; typeId: string }
  | { kind: 'marks'; marks: ConsoleViewMarksKind };

export type ConsoleCitationInputKind = 'prompt' | 'answer' | 'comment';

/**
 * The agent a cited session ran in when it is not a Nimbalyst session: a
 * terminal Claude Code session, whose transcript stays on the author's machine.
 */
export type ConsoleCitationAgent = 'claude-code';

export type ConsoleLinkTarget =
  | { kind: 'page'; scope: ConsoleLinkScope; pageId: string }
  /** A typed page; `itemRef` is the issue key when the item has one, else its id. */
  | { kind: 'item'; scope: ConsoleLinkScope; itemRef: string }
  | { kind: 'type'; scope: ConsoleLinkScope; typeId: string }
  | { kind: 'view'; scope: ConsoleLinkScope; view: ConsoleViewTarget }
  /** `agent` absent: a Nimbalyst session. `claude-code`: `sessionId` is the Claude Code session id. */
  | { kind: 'citation'; agent?: ConsoleCitationAgent; sessionId: string; inputKind: ConsoleCitationInputKind; key: string }
  /** A comment on a team page, cited: anyone on the team can open it, unlike a session citation. */
  | { kind: 'commentCitation'; scope: ConsoleTeamScope; pageId: string; commentId: string };

export interface ConsoleLinkParseOptions {
  /** Origins read as the console besides the production one (e.g. a local console). */
  origins?: readonly string[];
}

const DEEP_LINK_PREFIX = 'nimbalyst://console';
const LOCAL_SEGMENT = 'app';
const CITATION_KINDS: readonly ConsoleCitationInputKind[] = ['prompt', 'answer', 'comment'];
/** A terminal session's citable inputs: what the person typed, never comments. */
const AGENT_CITATION_KINDS: readonly ConsoleCitationInputKind[] = ['prompt', 'answer'];
const CITATION_AGENTS: readonly ConsoleCitationAgent[] = ['claude-code'];

/** `encodeURIComponent` plus the characters it leaves that would end a markdown link. */
function enc(value: string): string {
  return encodeURIComponent(value).replace(/[()'*!~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function dec(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

function scopePrefix(scope: ConsoleLinkScope): string {
  return scope === 'local' ? `/${LOCAL_SEGMENT}` : `/org/${enc(scope.orgId)}/project/${enc(scope.projectId)}`;
}

function viewTail(view: ConsoleViewTarget): string {
  if (view.kind === 'type') return `/view/type/${enc(view.typeId)}`;
  return view.marks === 'all' ? '/view/marks' : `/view/marks?kind=${view.marks}`;
}

/** The path and query of a console link, without the origin. */
export function consoleLinkPath(target: ConsoleLinkTarget): string {
  if (target.kind === 'citation') {
    const segments = [...(target.agent ? [target.agent] : []), target.sessionId, target.inputKind, target.key];
    return `/${LOCAL_SEGMENT}/cite/${segments.map(enc).join('/')}`;
  }
  if (target.kind === 'commentCitation') {
    return `${scopePrefix(target.scope)}/document/${enc(target.pageId)}?comment=${enc(target.commentId)}`;
  }
  const prefix = scopePrefix(target.scope);
  const local = target.scope === 'local';
  switch (target.kind) {
    case 'page':
      return `${prefix}/${local ? 'page' : 'document'}/${enc(target.pageId)}`;
    case 'item':
      return `${prefix}/${local ? 'item' : 'page/item'}/${enc(target.itemRef)}`;
    case 'type':
      return `${prefix}/${local ? 'type' : 'page/type'}/${enc(target.typeId)}`;
    case 'view':
      return `${prefix}${viewTail(target.view)}`;
  }
}

/** The https URL for a target. The only place one is built. */
export function buildConsoleLink(target: ConsoleLinkTarget, origin: string = CONSOLE_LINK_ORIGIN): string {
  return `${origin}${consoleLinkPath(target)}`;
}

/** Reads a path (already split from its origin) and query into a target. */
function parsePath(pathname: string, search: URLSearchParams): ConsoleLinkTarget | null {
  const raw = pathname.split('/').slice(1);
  if (raw.some((segment) => segment === '')) return null;
  let scope: ConsoleLinkScope;
  let rest: string[];
  if (raw[0] === LOCAL_SEGMENT) {
    scope = 'local';
    rest = raw.slice(1);
  } else if (raw[0] === 'org' && raw[2] === 'project' && raw.length > 4) {
    const orgId = dec(raw[1]!);
    const projectId = dec(raw[3]!);
    if (!orgId || !projectId) return null;
    scope = { orgId, projectId };
    rest = raw.slice(4);
  } else {
    return null;
  }
  const local = scope === 'local';
  const [head, a, b, c] = rest;

  if (rest[0] === 'view') {
    if (rest.length === 3 && a === 'type') {
      const typeId = dec(b!);
      return typeId ? { kind: 'view', scope, view: { kind: 'type', typeId } } : null;
    }
    if (rest.length === 2 && a === 'marks') {
      const kind = search.get('kind');
      if (kind === null) return { kind: 'view', scope, view: { kind: 'marks', marks: 'all' } };
      return kind === 'decided' || kind === 'open' ? { kind: 'view', scope, view: { kind: 'marks', marks: kind } } : null;
    }
    return null;
  }

  if (local) {
    if (head === 'cite' && rest.length === 4) {
      const sessionId = dec(a!);
      const key = dec(c!);
      const inputKind = b as ConsoleCitationInputKind;
      if (!sessionId || !key || !CITATION_KINDS.includes(inputKind)) return null;
      return { kind: 'citation', sessionId, inputKind, key };
    }
    // `cite/<agent>/<session>/<kind>/<key>`: one segment longer, so a parser
    // that predates agents reads it as nothing rather than as the wrong session.
    if (head === 'cite' && rest.length === 5) {
      const agent = a as ConsoleCitationAgent;
      const sessionId = dec(b!);
      const inputKind = c as ConsoleCitationInputKind;
      const key = dec(rest[4]!);
      if (!CITATION_AGENTS.includes(agent) || !sessionId || !key || !AGENT_CITATION_KINDS.includes(inputKind)) return null;
      return { kind: 'citation', agent, sessionId, inputKind, key };
    }
    if (rest.length !== 2) return null;
    const id = dec(a!);
    if (!id) return null;
    if (head === 'page') return { kind: 'page', scope, pageId: id };
    if (head === 'item') return { kind: 'item', scope, itemRef: id };
    if (head === 'type') return { kind: 'type', scope, typeId: id };
    return null;
  }

  if (head === 'document' && rest.length === 2) {
    const pageId = dec(a!);
    if (!pageId) return null;
    const comment = search.get('comment');
    if (comment === null) return { kind: 'page', scope, pageId };
    return comment && scope !== 'local' ? { kind: 'commentCitation', scope, pageId, commentId: comment } : null;
  }
  // `trackers/...` is the shape links had before the Pages routes.
  if ((head === 'page' || head === 'trackers') && rest.length === 3) {
    const id = dec(b!);
    if (!id) return null;
    if (a === 'item') return { kind: 'item', scope, itemRef: id };
    if (a === 'type') return { kind: 'type', scope, typeId: id };
  }
  return null;
}

/**
 * The target a console link points at, or null for any other URL, including
 * console routes that are not link targets (docs home, admin). The only place
 * one is read.
 */
export function parseConsoleLink(href: string | null | undefined, options: ConsoleLinkParseOptions = {}): ConsoleLinkTarget | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const origins = [CONSOLE_LINK_ORIGIN, ...(options.origins ?? [])];
  if (!origins.includes(url.origin)) return null;
  return parsePath(url.pathname, url.searchParams);
}

export function isConsoleLink(href: string | null | undefined, options?: ConsoleLinkParseOptions): boolean {
  return parseConsoleLink(href, options) !== null;
}

/**
 * The app deep link for a console link: same path and query under
 * `nimbalyst://console`. The console's "Open in Nimbalyst" page navigates to
 * it; the desktop maps it back with `consoleLinkFromDeepLink` and opens it
 * exactly as it opens a clicked console link.
 */
export function consoleLinkDeepLink(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!parsePath(url.pathname, url.searchParams)) return null;
  return `${DEEP_LINK_PREFIX}${url.pathname}${url.search}`;
}

/** The console link a `nimbalyst://console/...` deep link carries, or null. */
export function consoleLinkFromDeepLink(deepLink: string): string | null {
  if (!deepLink.startsWith(`${DEEP_LINK_PREFIX}/`)) return null;
  const href = `${CONSOLE_LINK_ORIGIN}${deepLink.slice(DEEP_LINK_PREFIX.length)}`;
  return parseConsoleLink(href) ? href : null;
}
