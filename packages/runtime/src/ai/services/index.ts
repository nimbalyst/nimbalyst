/**
 * AI Services
 *
 * Shared services for AI functionality across packages.
 */

export {
  DocumentContextService,
  escapeSelectedText,
  describeTranscriptSelectionSource,
} from './DocumentContextService';
export type {
  IDocumentContextService,
  RawDocumentContext,
  PreparedDocumentContext,
  DocumentState,
  DocumentTransition,
  TextSelection,
  TranscriptSelection,
  TranscriptSelectionSource,
  UserMessageAdditions,
  ContextPreparationResult,
  ModeTransition,
  TransitionResult,
  PersistedDocumentState,
  PersistDocumentStateCallback,
} from './types';
