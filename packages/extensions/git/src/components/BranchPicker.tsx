import { useState, useRef, useCallback, useMemo } from 'react';
import {
  useFloating, offset, flip, shift, FloatingPortal,
  useDismiss, useRole, useInteractions, autoUpdate,
} from '@floating-ui/react';

interface BranchPickerProps {
  branches: string[];
  current: string;
  onChange: (branch: string) => void;
}

// ---- Tree structure for "/" grouping ----

interface BranchTreeNode {
  folders: Record<string, BranchTreeNode>;
  leaves: { display: string; full: string }[];
}

function buildTree(branches: { display: string; full: string }[]): BranchTreeNode {
  const root: BranchTreeNode = { folders: {}, leaves: [] };
  for (const b of branches) {
    const parts = b.display.split('/');
    if (parts.length === 1) {
      root.leaves.push(b);
    } else {
      const folder = parts[0];
      if (!root.folders[folder]) root.folders[folder] = { folders: {}, leaves: [] };
      insertIntoTree(root.folders[folder], parts.slice(1), b.full);
    }
  }
  return root;
}

function insertIntoTree(node: BranchTreeNode, parts: string[], fullBranch: string): void {
  if (parts.length === 1) {
    node.leaves.push({ display: parts[0], full: fullBranch });
  } else {
    const folder = parts[0];
    if (!node.folders[folder]) node.folders[folder] = { folders: {}, leaves: [] };
    insertIntoTree(node.folders[folder], parts.slice(1), fullBranch);
  }
}

// ---- Recursive submenu component ----

interface FolderSubmenuProps {
  label: string;
  node: BranchTreeNode;
  current: string;
  onSelect: (branch: string) => void;
}

function FolderSubmenu({ label, node, current, onSelect }: FolderSubmenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(0), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  const open = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    closeTimer.current = setTimeout(() => setIsOpen(false), 80);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);

  const folderNames = Object.keys(node.folders).sort();

  return (
    <div
      ref={refs.setReference}
      className="git-branch-menu-item git-branch-menu-item--submenu"
      onMouseEnter={open}
      onMouseLeave={close}
      {...getReferenceProps()}
    >
      <span className="git-branch-menu-item-name">{label}</span>
      <span className="git-branch-menu-item-arrow">›</span>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="git-branch-menu"
            onMouseEnter={cancelClose}
            onMouseLeave={close}
            {...getFloatingProps()}
          >
            {/* Leaf branches first, then nested folders */}
            {node.leaves.map(b => {
              const isCurrent = b.full === current;
              return (
                <button
                  key={b.full}
                  className={`git-branch-menu-item${isCurrent ? ' git-branch-menu-item--current' : ''}`}
                  onClick={() => onSelect(b.full)}
                >
                  <span className="git-branch-menu-item-name">{b.display}</span>
                  {isCurrent && <span className="git-branch-menu-item-check">✓</span>}
                </button>
              );
            })}
            {folderNames.map(f => (
              <FolderSubmenu key={f} label={f} node={node.folders[f]} current={current} onSelect={onSelect} />
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

// ---- Render a tree node inline (for the top-level menu) ----

function renderTreeItems(
  node: BranchTreeNode,
  current: string,
  onSelect: (branch: string) => void,
) {
  const folderNames = Object.keys(node.folders).sort();
  return (
    <>
      {/* Leaves first (main, develop, etc.) then folder submenus */}
      {node.leaves.map(b => {
        const isCurrent = b.full === current;
        return (
          <button
            key={b.full}
            className={`git-branch-menu-item${isCurrent ? ' git-branch-menu-item--current' : ''}`}
            onClick={() => onSelect(b.full)}
          >
            <span className="git-branch-menu-item-name">{b.display}</span>
            {isCurrent && <span className="git-branch-menu-item-check">✓</span>}
          </button>
        );
      })}
      {folderNames.map(f => (
        <FolderSubmenu key={f} label={f} node={node.folders[f]} current={current} onSelect={onSelect} />
      ))}
    </>
  );
}

// ---- Main picker ----

export function BranchPicker({ branches, current, onChange }: BranchPickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  const handleSelect = useCallback((branch: string) => {
    onChange(branch);
    setIsOpen(false);
  }, [onChange]);

  // Parse into local vs remote, then build trees
  const { localTree, remoteEntries } = useMemo(() => {
    const localBranches: { display: string; full: string }[] = [];
    const remotes: Record<string, { display: string; full: string }[]> = {};

    for (const b of branches) {
      if (b.startsWith('remotes/')) {
        const rest = b.slice('remotes/'.length);
        const slashIdx = rest.indexOf('/');
        const remote = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
        const branch = slashIdx >= 0 ? rest.slice(slashIdx + 1) : '';
        if (!remotes[remote]) remotes[remote] = [];
        if (branch) remotes[remote].push({ display: branch, full: b });
      } else {
        localBranches.push({ display: b, full: b });
      }
    }

    return {
      localTree: buildTree(localBranches),
      remoteEntries: Object.entries(remotes).map(([name, rBranches]) => ({
        name,
        tree: buildTree(rBranches),
      })),
    };
  }, [branches]);

  const hasLocal = localTree.leaves.length > 0 || Object.keys(localTree.folders).length > 0;
  const hasRemotes = remoteEntries.length > 0;
  const displayLabel = current === 'HEAD'
    ? 'Detached HEAD'
    : current.startsWith('remotes/')
      ? current.slice('remotes/'.length)
      : current;

  return (
    <>
      <button
        ref={refs.setReference}
        className="git-log-select git-branch-picker-trigger"
        onClick={() => setIsOpen(v => !v)}
        title="Branch"
        {...getReferenceProps()}
      >
        {displayLabel || 'Loading...'}
        <span className="git-branch-picker-chevron">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="git-branch-menu"
            {...getFloatingProps()}
          >
            {/* Local branches */}
            {hasLocal && (
              <>
                <div className="git-branch-menu-section">Local</div>
                {renderTreeItems(localTree, current, handleSelect)}
              </>
            )}

            {/* Remote branches grouped by remote, then by "/" */}
            {hasRemotes && (
              <>
                {hasLocal && <div className="git-branch-menu-sep" />}
                <div className="git-branch-menu-section">Remotes</div>
                {remoteEntries.map(({ name, tree }) => (
                  <FolderSubmenu
                    key={name}
                    label={name}
                    node={tree}
                    current={current}
                    onSelect={handleSelect}
                  />
                ))}
              </>
            )}

            {branches.length === 0 && (
              <div className="git-branch-menu-empty">No branches</div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
