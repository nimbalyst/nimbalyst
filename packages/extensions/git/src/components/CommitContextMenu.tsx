import { useMemo } from 'react';
import {
  useFloating,
  flip,
  shift,
  FloatingPortal,
  useInteractions,
  useDismiss,
  useRole,
} from '@floating-ui/react';
import { copyToClipboard } from '@nimbalyst/extension-sdk';

interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface CommitContextMenuProps {
  commit: GitCommit;
  x: number;
  y: number;
  workspacePath: string;
  onClose: () => void;
  onMessage: (msg: string, isError?: boolean) => void;
  onRefresh: () => void;
}

const ipc = (window as unknown as { electronAPI: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }).electronAPI;

interface ActionResult {
  success: boolean;
  error?: string;
}

export function CommitContextMenu({
  commit,
  x,
  y,
  workspacePath,
  onClose,
  onMessage,
  onRefresh,
}: CommitContextMenuProps) {
  const virtualRef = useMemo(() => ({
    getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
  }), [x, y]);

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
    elements: { reference: virtualRef as unknown as Element },
    placement: 'bottom-start',
    middleware: [flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const dismiss = useDismiss(context, { escapeKey: true, outsidePress: true });
  const role = useRole(context, { role: 'menu' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const shortHash = commit.hash.slice(0, 7);

  const handleCopyId = () => {
    copyToClipboard(commit.hash);
    onMessage('Copied commit ID');
    onClose();
  };

  const handleCopyMessage = () => {
    copyToClipboard(commit.message);
    onMessage('Copied commit message');
    onClose();
  };

  const handleCheckout = async () => {
    onClose();
    const result = await ipc.invoke('git:checkout', workspacePath, commit.hash) as ActionResult;
    if (result.success) {
      onMessage(`Checked out ${shortHash} (detached HEAD)`);
      onRefresh();
    } else {
      onMessage(result.error ?? 'Checkout failed', true);
    }
  };

  const handleCherryPick = async () => {
    onClose();
    const result = await ipc.invoke('git:cherry-pick', workspacePath, commit.hash) as ActionResult;
    if (result.success) {
      onMessage(`Cherry-picked ${shortHash}`);
      onRefresh();
    } else {
      onMessage(result.error ?? 'Cherry-pick failed', true);
    }
  };

  const handleCreateBranch = async () => {
    const name = window.prompt(`Branch name (from ${shortHash}):`, '');
    if (!name?.trim()) return;
    onClose();
    const result = await ipc.invoke('git:create-branch', workspacePath, name.trim(), commit.hash) as ActionResult;
    if (result.success) {
      onMessage(`Created branch "${name.trim()}"`);
      onRefresh();
    } else {
      onMessage(result.error ?? 'Create branch failed', true);
    }
  };

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="git-context-menu"
        {...getFloatingProps()}
      >
        <button className="git-context-menu-item" onClick={handleCopyId}>
          Copy Commit ID
        </button>
        <button className="git-context-menu-item" onClick={handleCopyMessage}>
          Copy Commit Message
        </button>
        <div className="git-context-menu-sep" />
        <button className="git-context-menu-item" onClick={handleCheckout}>
          Checkout (Detached)
        </button>
        <button className="git-context-menu-item" onClick={handleCreateBranch}>
          Create Branch...
        </button>
        <div className="git-context-menu-sep" />
        <button className="git-context-menu-item" onClick={handleCherryPick}>
          Cherry Pick
        </button>
      </div>
    </FloatingPortal>
  );
}
