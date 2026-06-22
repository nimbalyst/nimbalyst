/**
 * Tip definitions registry
 *
 * All tip definitions are exported here as a single array.
 * Add new tip imports and include them in the array below.
 */

import type { TipDefinition } from '../types';
import { actionPromptsTip } from './action-prompts';
import { autoCommitTip } from './auto-commit';
import { claudeMdTip } from './claude-md';
import { contentSearchTip } from './content-search';
import { datamodelDiscoverTip } from './datamodel-discover';
import { docHistoryTip } from './doc-history';
import { documentSharedTip } from './document-shared';
import { excalidrawDiscoverTip } from './excalidraw-discover';
import { keyboardShortcutsTip } from './keyboard-shortcuts';
import { lightningInterruptTip } from './lightning-interrupt';
import { mobileKeepAwakeTip } from './mobile-keep-awake';
import { mobilePairedTip } from './mobile-paired';
import { mockupDiscoverTip } from './mockup-discover';
import { quickOpenTip } from './quick-open';
import { sessionCleanupTip } from './session-cleanup';
import { sessionSharedTip } from './session-shared';
import { spreadsheetDiscoverTip } from './spreadsheet-discover';
import { themeExploreTip } from './theme-explore';
import { trackerModeTip } from './tracker-mode';
import { wakeupTip } from './wakeup';
import { worktreeSessionTip } from './worktree-session';

export const tips: TipDefinition[] = [
  // Original five (priority 5-10 -- highest)
  mobileKeepAwakeTip,
  worktreeSessionTip,
  trackerModeTip,
  keyboardShortcutsTip,
  themeExploreTip,
  // Editor discovery
  excalidrawDiscoverTip,
  mockupDiscoverTip,
  datamodelDiscoverTip,
  spreadsheetDiscoverTip,
  // Sharing
  sessionSharedTip,
  documentSharedTip,
  // Power-user discovery
  claudeMdTip,
  autoCommitTip,
  docHistoryTip,
  quickOpenTip,
  contentSearchTip,
  mobilePairedTip,
  wakeupTip,
  actionPromptsTip,
  lightningInterruptTip,
  sessionCleanupTip,
];
