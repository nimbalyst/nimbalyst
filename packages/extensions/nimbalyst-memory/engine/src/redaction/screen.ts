/**
 * The single call a write path makes: blocklist, then redaction, then a residue
 * check that catches the case neither layer sees on its own — a page that
 * redacted cleanly but has nothing left in it.
 */
import { evaluateBlocklist, type BlocklistOptions } from './blocklist.js';
import { REDACTION_PLACEHOLDER_PATTERN, redactSecrets, type RedactOptions } from './redact.js';
import type { BlocklistMatch, ScreenOptions, ScreenResult } from './types.js';

/** Non-whitespace characters that are not part of a placeholder we inserted. */
function residualChars(text: string): number {
  return text.replace(REDACTION_PLACEHOLDER_PATTERN, '').replace(/\s+/g, '').length;
}

/**
 * Screen a page destined for storage.
 *
 * `ok: false` means do not store. `text` still carries the redacted form in
 * that case so the caller can show the user what was refused, but persisting it
 * would defeat the point.
 */
export function screenMemoryText(
  text: string,
  options: ScreenOptions & RedactOptions & BlocklistOptions = {}
): ScreenResult {
  const blocks: BlocklistMatch[] = options.skipBlocklist
    ? []
    : evaluateBlocklist(text, options).matches;

  const { text: redacted, findings } = redactSecrets(text, options);

  if (findings.length > 0) {
    const minChars = options.minResidualChars ?? 24;
    const minRatio = options.minResidualRatio ?? 0.2;
    const before = text.replace(/\s+/g, '').length;
    const after = residualChars(redacted);
    if (after < minChars || (before > 0 && after / before < minRatio)) {
      blocks.push({
        rule: 'redaction-left-nothing',
        reason:
          'redaction removed nearly all of the page; what remains is a record that credentials existed, not a memory',
      });
    }
  }

  return { ok: blocks.length === 0, text: redacted, redactions: findings, blocks };
}
