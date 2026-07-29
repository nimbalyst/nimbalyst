import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CommentThread } from './CommentThread';
import {
  FULL_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
  createCommentFixtures,
  createFixtureCommentAdapter,
  createFixtureResolver,
} from './commentFixtures';
import type { Actor, CommentCapabilities, ConversationContext } from './commentTypes';

/**
 * Fixture harness for reviewing the shared comment surface in a live window.
 *
 * Mounted from `renderer_eval` during design review:
 *
 *   const m = await import('/@fs/<repo>/packages/electron/src/renderer/components/Comments/CommentsHarness.tsx');
 *   m.mountCommentsHarness();
 *   m.unmountCommentsHarness();
 *
 * It exists as a real module rather than an inline eval string because the
 * eval context cannot resolve bare specifiers like `react`, and because a
 * harness that lives in the tree gets typechecked with everything else.
 *
 * Nothing in the app imports this. It ships no route, no menu entry, and no
 * side effects at import time.
 */

const HOST_ID = 'nimbalyst-comments-harness';

interface PaneSpec {
  label: string;
  width: number;
  capabilities: CommentCapabilities;
  supportsReactions: boolean;
  context?: Partial<ConversationContext>;
}

const PANES: PaneSpec[] = [
  { label: 'Room · 760px · full capabilities', width: 760, capabilities: FULL_CAPABILITIES, supportsReactions: true },
  {
    label: 'Tracker comments · 320px · adapter omits react()',
    width: 320,
    capabilities: FULL_CAPABILITIES,
    supportsReactions: false,
  },
  {
    label: 'Read-only · 300px · comment capability missing',
    width: 300,
    capabilities: READ_ONLY_CAPABILITIES,
    supportsReactions: true,
  },
  {
    label: 'Agent posting off · 300px',
    width: 300,
    capabilities: FULL_CAPABILITIES,
    supportsReactions: true,
    context: { agentPostingEnabled: false },
  },
];

function Harness() {
  const fixtures = createCommentFixtures({});
  const resolver = createFixtureResolver({ latencyMs: 250 });
  const viewerActor: Actor = {
    kind: 'user',
    userId: fixtures.viewerUserId,
    onBehalfOfUserId: fixtures.viewerUserId,
  };

  return (
    <div className="comments-harness flex h-full w-full gap-3 overflow-x-auto bg-[var(--nim-bg)] p-3">
      {PANES.map((pane) => (
        <div
          key={pane.label}
          className="comments-harness-pane flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--nim-border)]"
          style={{ width: pane.width }}
          data-harness-pane={pane.label}
        >
          <div className="border-b border-[var(--nim-border)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
            {pane.label}
          </div>
          <div className="min-h-0 flex-1">
            <CommentThread
              adapter={createFixtureCommentAdapter({
                capabilities: pane.capabilities,
                supportsReactions: pane.supportsReactions,
                sourceKind: pane.supportsReactions ? 'roomMessage' : 'trackerComment',
              })}
              capabilities={pane.capabilities}
              context={{ ...fixtures.context, ...pane.context }}
              directory={fixtures.directory}
              orgId={fixtures.orgId}
              viewerUserId={fixtures.viewerUserId}
              viewerActor={viewerActor}
              resolver={resolver}
              resourceCandidates={fixtures.candidates}
              onCopyLink={(urn) => {
                (window as unknown as { __lastCopiedUrn?: string }).__lastCopiedUrn = urn;
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

let root: Root | null = null;

export function mountCommentsHarness(): string {
  unmountCommentsHarness();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Harness />);
  return HOST_ID;
}

export function unmountCommentsHarness(): void {
  root?.unmount();
  root = null;
  document.getElementById(HOST_ID)?.remove();
}
