/**
 * PullRequestMode — the GitHub panel.
 *
 * Despite the name (kept because the ContentMode is still `pr-review`, and
 * App.tsx holds this component's ref), this hosts *both* GitHub lists. It
 * mounts exactly ONE GithubPanelShell and swaps which list's slots that shell
 * renders, because the shell owns the pinned ChatSidebar: giving each list its
 * own shell would tear down the live chat session every time the segmented
 * control is used, which is the opposite of the point.
 *
 * Each list is a hook (usePullRequestPanel / useIssuePanel) that owns its own
 * poll lifecycle, filter vocabulary, selection, and actions and returns the
 * nodes plus chat wiring the shell needs. Both hooks run on every render —
 * hook order must not depend on which list is showing — and each is told
 * whether it is the visible one, so the hidden list neither fetches nor
 * publishes chat context.
 */

import type { JSX } from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  prRemoteAtom,
  prModeLayoutAtom,
  setPrModeLayoutAtom,
  prListAtom,
  initPrModeLayout,
  type GithubListKind,
} from '../../store/atoms/pullRequests';
import { githubIssueListAtom } from '../../store/atoms/githubIssues';
import { GithubPanelShell, type GithubPanelChatHandle } from './GithubPanelShell';
import { GithubListSwitcher } from './GithubListSwitcher';
import { PrRepoPicker } from './PrRepoPicker';
import { usePullRequestPanel } from './usePullRequestPanel';
import { useIssuePanel } from './issues/useIssuePanel';

interface PullRequestModeProps {
  workspacePath: string;
  workspaceName: string;
  isActive: boolean;
  onFileOpen?: (filePath: string) => Promise<void> | void;
  onPanelStateChange?: (state: { chatCollapsed: boolean }) => void;
}

export interface PullRequestModeRef {
  toggleChatCollapsed: () => void;
  createNewChatSession: () => Promise<void>;
}

export const PullRequestMode = forwardRef<PullRequestModeRef, PullRequestModeProps>(function PullRequestMode({
  workspacePath,
  workspaceName,
  isActive,
  onFileOpen,
  onPanelStateChange,
}, ref): JSX.Element {
  const remote = useAtomValue(prRemoteAtom);
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const prList = useAtomValue(prListAtom);
  const issueList = useAtomValue(githubIssueListAtom);

  const remoteForWorkspace =
    remote && remote.workspacePath === workspacePath ? remote.remote : null;
  const chatRef = useRef<GithubPanelChatHandle>(null);
  const activeList = layout.activeGithubList;

  // Load persisted layout when the workspace becomes known / changes. Runs
  // whether or not the workspace has a GitHub remote — it is the panel's
  // layout, not a list's.
  useEffect(() => {
    void initPrModeLayout(workspacePath);
  }, [workspacePath]);

  const prSlots = usePullRequestPanel({
    workspacePath,
    remote: remoteForWorkspace,
    isActive,
    isVisible: activeList === 'prs',
    chatRef,
  });
  const issueSlots = useIssuePanel({
    workspacePath,
    remote: remoteForWorkspace,
    isActive,
    isVisible: activeList === 'issues',
    chatRef,
  });
  const slots = activeList === 'issues' ? issueSlots : prSlots;

  const handleSwitchList = useCallback(
    (kind: GithubListKind) => setLayout({ activeGithubList: kind }),
    [setLayout],
  );

  // The public ref surface delegates to the shell's chat rail; `chatRef` is
  // stable, so this handle never has to be rebuilt.
  useImperativeHandle(ref, () => ({
    toggleChatCollapsed: () => chatRef.current?.toggleCollapsed(),
    createNewChatSession: async () => {
      await chatRef.current?.createNewSession();
    },
  }), []);

  // NOTE: every hook above must run unconditionally — this early return is the
  // only branch in the component, so switching to a project without a GitHub
  // remote must not change the hook count, or React throws "Rendered fewer
  // hooks than expected". The shell stays mounted either way, so the panel's
  // collapse state keeps reporting while there is nothing to list.
  if (!remoteForWorkspace) {
    return (
      <GithubPanelShell
        ref={chatRef}
        workspacePath={workspacePath}
        isActive={isActive}
        onPanelStateChange={onPanelStateChange}
        placeholder={
          <div className="pr-review-placeholder flex flex-1 flex-col items-center justify-center gap-3 text-nim-muted text-sm">
            {/* A repository without a GitHub remote must not strand the panel */}
            <PrRepoPicker workspacePath={workspacePath} />
            <span>No GitHub remote detected for {workspaceName}.</span>
          </div>
        }
      />
    );
  }

  return (
    <GithubPanelShell
      ref={chatRef}
      workspacePath={workspacePath}
      isActive={isActive}
      listHeader={
        <div className="pr-list-header flex items-center gap-2">
          <PrRepoPicker workspacePath={workspacePath} />
          <GithubListSwitcher
            active={activeList}
            onChange={handleSwitchList}
            prCount={prList.length}
            issueCount={issueList.length}
          />
        </div>
      }
      sidebar={slots.sidebar}
      list={slots.list}
      detail={slots.detail}
      documentContext={slots.documentContext}
      getDocumentContext={slots.getDocumentContext}
      onFileOpen={onFileOpen}
      selectionKey={slots.selectionKey}
      selectionSessions={slots.selectionSessions}
      onPanelStateChange={onPanelStateChange}
    />
  );
});

PullRequestMode.displayName = 'PullRequestMode';
