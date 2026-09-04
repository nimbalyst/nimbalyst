/**
 * The memory write gate. Everything a page must pass before it is stored,
 * synced to a team, or exported into the committed JSONL replica.
 *
 * `screenMemoryText` is the entry point; the layers underneath are exported for
 * callers that need one without the other (the review UI re-runs redaction to
 * highlight spans, the exporter re-runs the blocklist as a last check).
 */
export { screenMemoryText } from './screen.js';
export { redactSecrets, containsSecret, redactionPlaceholder, REDACTION_PLACEHOLDER_PATTERN } from './redact.js';
export type { RedactOptions } from './redact.js';
export { evaluateBlocklist } from './blocklist.js';
export type { BlocklistOptions } from './blocklist.js';
export { DEFAULT_DETECTORS, looksLikePlaceholder, hasKeyEntropy, luhnValid } from './detectors.js';
export type { Detector } from './detectors.js';
export type {
  SecretKind,
  RedactionFinding,
  RedactionResult,
  BlocklistRuleId,
  BlocklistMatch,
  BlocklistResult,
  ScreenResult,
  ScreenOptions,
} from './types.js';
