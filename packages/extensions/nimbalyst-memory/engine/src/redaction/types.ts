/**
 * Types for the write-gate that every memory page passes through before it is
 * stored. Two distinct layers, deliberately separated:
 *
 * - **Redaction** locates a *shaped* secret inside otherwise-valuable prose and
 *   replaces just that span. The page survives; the token does not.
 * - **Blocklist** refuses the page outright, for content where redaction is not
 *   a meaningful remedy (the secret has no locatable shape, or nothing of value
 *   would remain).
 *
 * Both report structurally. A silent redaction is indistinguishable from a
 * miss, so callers get findings they can surface as "this was redacted before
 * storage" and tests can assert on the finding rather than the output string.
 */

/** A class of secret the redactor knows how to find. */
export type SecretKind =
  | 'openai-api-key'
  | 'anthropic-api-key'
  | 'google-api-key'
  | 'github-token'
  | 'aws-access-key-id'
  | 'aws-secret-access-key'
  | 'slack-token'
  | 'stripe-key'
  | 'npm-token'
  | 'jwt'
  | 'bearer-token'
  | 'basic-auth-credentials'
  | 'private-key-block'
  | 'connection-string-password'
  | 'env-assignment';

/**
 * One redacted span, reported in coordinates of the ORIGINAL text so a review
 * UI can highlight the source. `preview` is deliberately lossy: it identifies
 * *which* secret without reproducing it, so it is safe to log or display.
 */
export interface RedactionFinding {
  kind: SecretKind;
  /** Human-readable description of the class, for review UI. */
  label: string;
  /** Offset of the redacted span in the original text. */
  start: number;
  /** End offset (exclusive) in the original text. */
  end: number;
  /** 1-based line number of `start` in the original text. */
  line: number;
  /** Non-reversible hint, e.g. `sk-…(51 chars)`. Never the secret. */
  preview: string;
}

export interface RedactionResult {
  /** The text with every finding replaced by its placeholder. */
  text: string;
  findings: RedactionFinding[];
  /** True when at least one finding was applied. */
  redacted: boolean;
}

/** Rules under which a page is refused entirely rather than redacted. */
export type BlocklistRuleId =
  /** Private key material: never context, always payload. */
  | 'private-key-material'
  /** Three or more credential assignments: the page IS the credentials. */
  | 'credential-dump'
  /** Prose asserting a credential whose value has no findable shape. */
  | 'unlocatable-secret'
  /** A Luhn-valid payment card number. No work memory needs one. */
  | 'payment-card'
  /** Redaction succeeded but left nothing worth storing. */
  | 'redaction-left-nothing';

export interface BlocklistMatch {
  rule: BlocklistRuleId;
  /** Why this page is refused, phrased for the user. */
  reason: string;
  /** 1-based line that triggered the rule, when a single line did. */
  line?: number;
}

export interface BlocklistResult {
  blocked: boolean;
  matches: BlocklistMatch[];
}

/** The combined verdict from {@link screenMemoryText}. */
export interface ScreenResult {
  /** False means: do not store this page at all. */
  ok: boolean;
  /**
   * The text to store when `ok`. When blocked this still carries the redacted
   * form, so a caller may show the user what was rejected — but it must not be
   * persisted.
   */
  text: string;
  redactions: RedactionFinding[];
  blocks: BlocklistMatch[];
}

export interface ScreenOptions {
  /**
   * Minimum surviving non-placeholder characters before a redacted page is
   * treated as a husk and blocked. Default 24.
   */
  minResidualChars?: number;
  /**
   * Minimum fraction of the original non-whitespace characters that must
   * survive redaction. Default 0.2.
   */
  minResidualRatio?: number;
  /** Skip the blocklist layer (redaction only). Default false. */
  skipBlocklist?: boolean;
}
