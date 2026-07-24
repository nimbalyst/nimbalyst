import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { tipCreateWorktreeSessionRequestAtom } from '../atoms';
import type { TipDefinition } from '../types';

const BranchIcon = <MaterialSymbol icon="account_tree" size={16} />;

export const worktreeSessionTip: TipDefinition = {
  id: 'tip-worktree-session',
  name: 'Worktree Session Suggestion',
  version: 1,
  trigger: {
    screen: 'agent',
    condition: (context) =>
      context.isGitRepo &&
      context.isWorktreesAvailable &&
      !context.workspacePath?.includes('_worktrees/') &&
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 10) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.WORKTREE_CREATED),
    delay: 2500,
    priority: 7,
  },
  content: {
    icon: BranchIcon,
    title: 'Isolate risky work in a worktree',
    body: 'You are deep into agent sessions on a git repo, but have not created a **worktree session** yet. Worktrees give experiments their own branch and working directory without disturbing the main checkout.',
    action: {
      label: 'New Worktree Session',
      onClick: () => {
        store.set(setWindowModeAtom, 'agent');
        store.set(tipCreateWorktreeSessionRequestAtom, (prev) => prev + 1);
      },
      variant: 'primary',
    },
  },
};
