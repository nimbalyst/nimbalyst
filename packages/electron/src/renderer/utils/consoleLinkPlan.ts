/**
 * What this window does with a console link (`https://console.nimbalyst.com/...`)
 * the user clicked: open its target here, leave it to the browser, or say the
 * target is not here.
 *
 * A team link opens here only when this window's team and project are the
 * link's; anything else goes to the browser, where the console shows it to
 * whoever is signed in. A local link (Personal page, personal typed page,
 * session citation) only ever means something on this desktop, so it never
 * goes to the browser: the console would only send it back.
 *
 * Pure, so the decision is tested without a window; `openConsoleLink.ts` runs it.
 */
import { parseConsoleLink } from '@nimbalyst/collab-protocol';

export interface ConsoleLinkOpenContext {
  /** This window's team project, or null when the workspace has none. */
  team: { orgId: string; teamProjectId: string } | null;
  /** An item id for an issue key or id this workspace holds, else null. */
  resolveItem: (itemRef: string) => string | null;
}

export type ConsoleLinkPlan =
  | { action: 'team-document'; documentId: string }
  | { action: 'item'; itemId: string }
  | { action: 'type'; typeId: string; personal: boolean }
  | { action: 'personal-page'; pageId: string }
  | { action: 'session'; sessionId: string }
  | { action: 'missing'; what: 'page' | 'view' }
  | { action: 'browser' };

/** The plan for `href`, or null when it is not a console link at all. */
export function planConsoleLinkOpen(href: string, context: ConsoleLinkOpenContext): ConsoleLinkPlan | null {
  const target = parseConsoleLink(href);
  if (!target) return null;
  if (target.kind === 'citation') {
    // A Claude Code session lives in the author's terminal, not in Nimbalyst; the console page says so.
    if (target.agent) return { action: 'browser' };
    return { action: 'session', sessionId: target.sessionId };
  }

  const local = target.scope === 'local';
  if (target.scope !== 'local') {
    const { team } = context;
    if (!team || team.orgId !== target.scope.orgId || team.teamProjectId !== target.scope.projectId) {
      return { action: 'browser' };
    }
  }

  switch (target.kind) {
    case 'page':
      return local ? { action: 'personal-page', pageId: target.pageId } : { action: 'team-document', documentId: target.pageId };
    case 'commentCitation':
      return { action: 'team-document', documentId: target.pageId };
    case 'item': {
      const itemId = context.resolveItem(target.itemRef);
      return itemId ? { action: 'item', itemId } : { action: 'missing', what: 'page' };
    }
    case 'type':
      return { action: 'type', typeId: target.typeId, personal: local };
    case 'view':
      // A view of a type opens the type's page; a marks list has no page of its own.
      if (target.view.kind === 'type') return { action: 'type', typeId: target.view.typeId, personal: local };
      return local ? { action: 'missing', what: 'view' } : { action: 'browser' };
  }
}

/** The link a new typed-page reference is written with; shared with the web console. */
export { trackerReferenceLinkFor } from '@nimbalyst/collab-client/trackers';
