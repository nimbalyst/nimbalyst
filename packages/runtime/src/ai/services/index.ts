/**
 * AI Services
 *
 * Shared services for AI functionality across packages.
 */

export { DocumentContextService } from './DocumentContextService';
export type {
  IDocumentContextService,
  RawDocumentContext,
  PreparedDocumentContext,
  DocumentState,
  DocumentTransition,
  TextSelection,
  UserMessageAdditions,
  ContextPreparationResult,
  ModeTransition,
  TransitionResult,
  PersistedDocumentState,
  PersistDocumentStateCallback,
} from './types';
