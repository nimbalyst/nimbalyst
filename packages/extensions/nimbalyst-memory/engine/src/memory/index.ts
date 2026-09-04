/**
 * Fact model v3 — the `memory` record on the tracker substrate.
 *
 * The type itself is DEFINED in `schema.ts` and deliberately not created; see
 * that file's header for the one step that creates it.
 */
export {
  MEMORY_SCHEMA_VERSION,
  MEMORY_TYPES,
  MEMORY_PAGE_MIN_CHARS,
  MEMORY_PAGE_MIN_SENTENCES,
  MEMORY_PAGE_SOFT_LIMIT_BYTES,
  DEFAULT_CONFIDENCE,
  DURABLE_MEMORY_FIELDS,
  VOLATILE_MEMORY_FIELDS,
} from './types.js';
export type {
  MemoryType,
  MemoryScope,
  MemoryStatus,
  MemoryProvenance,
  MemoryRecord,
  MemoryReplicaRecord,
  DurableMemoryFields,
  VolatileMemoryFields,
} from './types.js';

export { MEMORY_TRACKER_SCHEMA, MEMORY_FIELD_NAMES } from './schema.js';

export { toReplicaRecord, toReplicaRecords, committableRecords, VOLATILE_FIELD_NAMES } from './replica.js';

export { resolveMemories } from './resolve.js';
export type {
  ResolvedMemories,
  ResolveOptions,
  SuppressedMemory,
  MemorySuppressionReason,
} from './resolve.js';

export { writeMemoryPage, markSuperseded, memoryFactId } from './write.js';
export type {
  MemoryWriteInput,
  MemoryWriteOptions,
  MemoryWriteOutcome,
  MemoryWriteWarning,
  MemoryShapeProblem,
} from './write.js';

export { migrateVoiceMemory } from './migrateVoiceMemory.js';
export type {
  VoiceMemoryMigration,
  VoiceMemoryMigrationOptions,
  SkippedVoiceMemory,
} from './migrateVoiceMemory.js';
