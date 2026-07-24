/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Core diff types
export type {Change} from './diffPluginUtils';

// Plugin utilities (needed for React plugin and toolbar)
export {
  $approveDiffs,
  $rejectDiffs,
  APPLY_DIFF_COMMAND,
  APPROVE_DIFF_COMMAND,
  REJECT_DIFF_COMMAND,
} from './diffPluginUtils';

// DiffState utilities for diff tracking
export {
  $getDiffState,
  $setDiffState,
  $clearDiffState,
  $hasDiffState,
} from './DiffState';
export type {DiffStateType} from './DiffState';

// Main API - the primary entry point
export {applyMarkdownDiff, applyMarkdownReplace} from './diffUtils';
export type {TextReplacement} from './diffUtils';

// Testing utilities - these should eventually be moved to a separate test package
export {NodeStructureValidator} from './NodeStructureValidator';
export {generateUnifiedDiff} from './standardDiffFormat';

export {diffHandlerRegistry} from '../handlers';
export {NoopDiffHandler} from '../handlers/NoopDiffHandler';

export {DiffError} from './DiffError';
