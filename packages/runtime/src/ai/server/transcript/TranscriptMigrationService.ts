/**
 * @deprecated Renamed to TranscriptRuntime in Phase 3 of the
 * canonical-transcript-deprecation plan. This file is kept as a thin
 * re-export so existing import sites keep compiling until they are
 * migrated to the new name. New code should import TranscriptRuntime
 * directly.
 */

import type { IRawMessageStore } from './TranscriptTransformer';
import { TranscriptRuntime } from './TranscriptRuntime';
import type { ITranscriptEventStore } from './types';

/**
 * Backwards-compatible constructor wrapper. Old callers used to pass a
 * persisted ITranscriptEventStore and an ISessionMetadataStore; both
 * arguments are now ignored — canonical events live in TranscriptRuntime's
 * in-memory cache and the watermark/metadata store is internal.
 */
export class TranscriptMigrationService extends TranscriptRuntime {
  constructor(
    rawStore: IRawMessageStore,
    _transcriptStore?: ITranscriptEventStore,
    _metadataStore?: unknown,
  ) {
    super(rawStore);
  }
}
