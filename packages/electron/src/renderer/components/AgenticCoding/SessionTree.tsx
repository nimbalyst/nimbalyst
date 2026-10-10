import React, { useMemo } from 'react';
import { atom, useAtom, useAtomValue, type Getter } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  sessionRegistryAtom,
  sessionProcessingAtom,
  sessionUnreadAtom,
  sessionHasPendingInteractivePromptAtom,
  type SessionMeta,
} from '../../store/atoms/sessions';
import { workspaceSessionTurnActivityAtom } from '../../store/atoms/sessionActivity';
import { workstreamStateAtom } from '../../store/atoms/workstreamState';
import { compactRowsAtom } from '../../store/atoms/agentMode';
import { SessionListItem } from './SessionListItem';
import { buildSessionTree, mergedTreeHeader, treeIndent, type SessionTreeNode } from './sessionTreeModel';

export interface SessionTreeProps {
  sessions: SessionMeta[];
  root?: SessionMeta;
  activeSessionId: string | null;
  projectPath?: string;
  onSessionSelect: (id: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onSessionDelete?: (id: string) => void;
  onSessionArchive?: (id: string) => void;
  onSessionUnarchive?: (id: string) => void;
  onSessionPinToggle?: (id: string, pinned: boolean) => void;
  onSessionRename?: (id: string, title: string) => void;
  onSessionBranch?: (id: string) => void;
}

export type SessionTreeRowHandlers = Omit<SessionTreeProps, 'sessions' | 'root'>;

/** One visible row of a flattened tree; virtual lists render one of these per item. */
export interface VisibleSessionTreeRow {
  node: SessionTreeNode<SessionMeta>;
  baseDepth: number;
  /** Set on a tree's top row: a merged wrapper keeps the pin identity of the hidden root. */
  pinSession?: SessionMeta;
}

/** Explicit toggle wins; otherwise a node opens while any member needs attention or is active. */
function readTreeExpanded(get: Getter, node: { id: string; ids: readonly string[] }, activeSessionId: string | null): boolean {
  const explicit = get(workstreamStateAtom(node.id)).treeExpanded;
  if (explicit !== undefined && explicit !== null) return explicit;
  return node.ids.some(
    (id) =>
      id === activeSessionId ||
      get(sessionProcessingAtom(id)) ||
      get(sessionUnreadAtom(id)) ||
      get(sessionHasPendingInteractivePromptAtom(id))
  );
}

/**
 * Flattens each tree to its visible preorder rows. Virtualizing a whole tree as a
 * single item made one item thousands of pixels tall and change height whenever an
 * agent started or stopped, which made the scroll position jump.
 */
export function useVisibleSessionTreeRows(
  trees: readonly { key: string; rows: readonly SessionMeta[] }[],
  activeSessionId: string | null,
  projectPath: string
): Map<string, VisibleSessionTreeRow[]> {
  const registry = useAtomValue(sessionRegistryAtom);
  const activity = useAtomValue(workspaceSessionTurnActivityAtom(projectPath));
  const forests = useMemo(
    () =>
      trees.map(({ key, rows }) => ({
        key,
        roots: buildSessionTree(
          rows.map((row) => {
            const current = registry.get(row.id) ?? row;
            return { ...current, updatedAt: Math.max(current.updatedAt, activity.get(row.id) ?? 0) };
          })
        ),
      })),
    [trees, registry, activity]
  );
  // The atom must keep its identity across renders: useAtomValue re-subscribes and
  // re-renders on every new atom, so keying on object identity loops. Key on the
  // parent nodes and their members, which is everything the atom reads.
  const parents = forests.flatMap((forest) => {
    const out: { id: string; ids: string[] }[] = [];
    const visit = (node: SessionTreeNode<SessionMeta>) => {
      if (!node.children.length) return;
      out.push({ id: node.session.id, ids: node.ids });
      node.children.forEach(visit);
    };
    forest.roots.forEach(visit);
    return out;
  });
  const parentsKey = parents.map((parent) => parent.ids.join(',')).join('|');
  // A joined string keeps the subscription quiet unless the expanded set really changes.
  const expandedKey = useAtomValue(
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parentsKey covers parents
    useMemo(() => atom((get) => parents.filter((parent) => readTreeExpanded(get, parent, activeSessionId)).map((parent) => parent.id).join('\0')), [parentsKey, activeSessionId])
  );
  return useMemo(() => {
    const expanded = new Set(expandedKey ? expandedKey.split('\0') : []);
    const result = new Map<string, VisibleSessionTreeRow[]>();
    for (const forest of forests) {
      const rows: VisibleSessionTreeRow[] = [];
      for (const root of forest.roots) {
        const header = mergedTreeHeader(root);
        const visit = (node: SessionTreeNode<SessionMeta>, pinSession?: SessionMeta) => {
          rows.push({ node, baseDepth: header.depth, pinSession });
          if (expanded.has(node.session.id)) node.children.forEach((child) => visit(child));
        };
        visit(header, root.session);
      }
      result.set(forest.key, rows);
    }
    return result;
  }, [forests, expandedKey]);
}

/** Non-virtual tree, used inside worktree groups. */
export function SessionTree(props: SessionTreeProps) {
  const projectPath = props.projectPath || props.root?.workspaceId || props.sessions[0]?.workspaceId || '';
  const trees = useMemo(
    () => [{ key: 'tree', rows: props.root ? [props.root, ...props.sessions] : props.sessions }],
    [props.root, props.sessions]
  );
  const rows = useVisibleSessionTreeRows(trees, props.activeSessionId, projectPath).get('tree') ?? [];
  return (
    <div className="session-tree" role="tree" aria-label="Session tree">
      {rows.map((row) => (
        <SessionTreeRow key={row.node.session.id} {...props} {...row} />
      ))}
    </div>
  );
}

export function SessionTreeRow(props: SessionTreeRowHandlers & VisibleSessionTreeRow) {
  const { node, baseDepth, activeSessionId } = props;
  const row = node.session;
  const pinSession = props.pinSession ?? row;
  const [, setState] = useAtom(workstreamStateAtom(row.id));
  const compact = useAtomValue(compactRowsAtom);
  const status = useAtomValue(
    useMemo(
      () =>
        atom((get) => {
          let running = 0;
          let unread = 0;
          let review = 0;
          for (const id of node.ids) {
            if (get(sessionProcessingAtom(id))) running++;
            if (get(sessionUnreadAtom(id))) unread++;
            if (get(sessionHasPendingInteractivePromptAtom(id))) review++;
          }
          return { running, unread, review, expanded: readTreeExpanded(get, { id: row.id, ids: node.ids }, activeSessionId) };
        }),
      // Keyed by content, not node identity, so a re-sorted list never mints a new atom.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [row.id, node.ids.join('\0'), activeSessionId]
    )
  );
  const expanded = status.expanded;
  const indent = treeIndent(node.depth - baseDepth);
  const hasChildren = node.children.length > 0;
  const hiddenCount = node.ids.length - 1;
  // SessionListItem's memo compares these by reference; build them only when
  // their inputs change so an unrelated list render does not repaint every row.
  // Inline on the metadata line; a separate row per parent cost a line of height each.
  const details = useMemo(() => hasChildren && (
    <span className="session-tree-rollup inline-flex shrink-0 gap-1.5 whitespace-nowrap text-[10px] text-[var(--nim-text-muted)]">
      {status.running > 0 && <span className="text-[var(--nim-primary)]">{status.running} running</span>}
      {status.unread > 0 && <span>{status.unread} unread</span>}
      {status.review > 0 && <span>{status.review} need review</span>}
      {node.uncommittedCount > 0 && (
        <span className="text-[var(--nim-warning)]">{node.uncommittedCount} uncommitted</span>
      )}
      {!expanded && <span>{hiddenCount} sessions</span>}
    </span>
  ), [hasChildren, status.running, status.unread, status.review, node.uncommittedCount, expanded, hiddenCount]);
  const leading = useMemo(() => (
    hasChildren ? (
      <button
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.title}`}
        aria-expanded={expanded}
        className={`session-tree-chevron shrink-0 flex items-center p-0 leading-none ${compact ? "" : "mt-1"}`}
        onClick={(e) => {
          e.stopPropagation();
          setState({ treeExpanded: !expanded });
        }}
      >
        <MaterialSymbol icon={expanded ? 'expand_more' : 'chevron_right'} size={14} />
      </button>
    ) : (
      <span className="w-3.5 shrink-0" />
    )
  ), [hasChildren, expanded, row.title, compact, setState]);
  return (
    <div
      className="session-tree-row"
      role="treeitem"
      aria-level={node.depth - baseDepth + 1}
      aria-expanded={node.children.length ? expanded : undefined}
      style={{
        marginLeft: indent.level * 16,
        borderLeft: indent.rail ? '1px solid var(--nim-border)' : undefined,
      }}
    >
      <SessionListItem
        {...row}
        isPinned={pinSession.isPinned}
        title={row.title || 'Untitled Session'}
        isActive={row.id === activeSessionId}
        treeContext
        projectPath={props.projectPath || row.workspaceId}
        isWorkstream={hasChildren}
        treeLeading={leading}
        treeDetails={details}
        compact={compact}
        uncommittedCount={node.children.length ? undefined : row.uncommittedCount}
        onClick={(e) => props.onSessionSelect(row.id, e)}
        onDelete={props.onSessionDelete && (() => props.onSessionDelete!(row.id))}
        onArchive={props.onSessionArchive && (() => props.onSessionArchive!(row.id))}
        onUnarchive={props.onSessionUnarchive && (() => props.onSessionUnarchive!(row.id))}
        onPinToggle={props.onSessionPinToggle && ((pinned) => props.onSessionPinToggle!(pinSession.id, pinned))}
        onRename={props.onSessionRename && ((title) => props.onSessionRename!(row.id, title))}
        onBranch={props.onSessionBranch && (() => props.onSessionBranch!(row.id))}
      />
    </div>
  );
}
