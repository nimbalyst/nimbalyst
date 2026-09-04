/**
 * The never-remember blocklist: content that is refused outright rather than
 * redacted.
 *
 * The line between the two layers is not severity, it is whether redaction is a
 * *remedy*. A rule belongs here when one of two things is true:
 *
 * 1. **The secret has no findable shape.** "the deploy password is hunter2" —
 *    a regex can locate the claim but not reliably bound the value. Storing the
 *    page stores the secret; there is nothing to excise.
 * 2. **Redaction leaves a husk.** A page whose content *is* a key, or a pasted
 *    `.env` file, becomes a row of placeholders. It carries no memory and still
 *    signals "credentials were here", so it should never have been stored.
 *
 * Everything else stays in redaction, deliberately. Blocking is lossy and the
 * user does not get a second chance to write the page down.
 */
import { PRIVATE_KEY_BLOCK, isSecretEnvName, looksLikePlaceholder, luhnValid } from './detectors.js';
import type { BlocklistMatch, BlocklistResult } from './types.js';

/**
 * Assignment lines, filtered by the same name test the redactor uses so the two
 * layers agree on what counts as a credential.
 */
const ASSIGNMENT_LINE =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(\S[^\n]*)$/gm;

/**
 * Claims that name a credential whose value the redactor cannot bound. Each
 * requires an actual assertion of a value — a page *discussing* passwords is
 * not blocked, a page *stating* one is.
 */
const UNLOCATABLE_SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  {
    re: /\b(?:the|my|our|their|its|his|her|this)\s+(?:\w+\s+){0,2}(?:password|passphrase|pin|passcode|one[- ]time\s+code|otp|recovery\s+code|security\s+answer)\s+(?:is|was|will\s+be)\b[ \t]*\S/i,
    reason: 'states a password or passphrase in prose, where redaction cannot bound the value',
  },
  {
    re: /^[ \t]*(?:password|passphrase|passcode|pin)[ \t]*[:=][ \t]*(\S+)[ \t]*$/im,
    reason: 'records a bare password value',
  },
  {
    re: /\b(?:seed|recovery|mnemonic|backup)\s+phrase\b/i,
    reason: 'mentions a recovery or seed phrase, which is unbounded plain words and never storable',
  },
  {
    re: /-----BEGIN\b[\s\S]{0,200}?\bPRIVATE KEY/i,
    reason: 'contains private key material',
  },
];

/** Digit runs long enough to be a card, before Luhn narrows them down. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export interface BlocklistOptions {
  /**
   * How many credential assignment lines make a page a dump rather than a page
   * that happens to quote one. Default 3.
   */
  credentialDumpThreshold?: number;
}

/**
 * Evaluate the categorical rules. Returns every match rather than the first, so
 * the caller can tell the user all the reasons at once instead of one per
 * attempt.
 */
export function evaluateBlocklist(text: string, options: BlocklistOptions = {}): BlocklistResult {
  const matches: BlocklistMatch[] = [];

  const pem = new RegExp(PRIVATE_KEY_BLOCK.source, PRIVATE_KEY_BLOCK.flags);
  const pemMatch = pem.exec(text);
  if (pemMatch) {
    matches.push({
      rule: 'private-key-material',
      reason: 'contains a PEM private key block; key material is never context, only payload',
      line: lineOf(text, pemMatch.index),
    });
  }

  for (const { re, reason } of UNLOCATABLE_SECRET_PATTERNS) {
    const scoped = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const hit = scoped.exec(text);
    if (!hit) continue;
    // A documented placeholder (`password: <your-password>`) is a doc, not a leak.
    const value = hit[1];
    if (value !== undefined && looksLikePlaceholder(value)) continue;
    // The PEM case is already reported under its own, more precise rule.
    if (/PRIVATE KEY/.test(hit[0]) && matches.some((m) => m.rule === 'private-key-material')) continue;
    matches.push({ rule: 'unlocatable-secret', reason, line: lineOf(text, hit.index) });
  }

  const dumpThreshold = options.credentialDumpThreshold ?? 3;
  const assignments = new RegExp(ASSIGNMENT_LINE.source, ASSIGNMENT_LINE.flags);
  let assignmentCount = 0;
  let firstAssignment = -1;
  let assignment: RegExpExecArray | null;
  while ((assignment = assignments.exec(text)) !== null) {
    if (!isSecretEnvName(assignment[1] ?? '')) continue;
    const value = (assignment[2] ?? '').trim();
    if (value.length < 8 || looksLikePlaceholder(value)) continue;
    if (firstAssignment < 0) firstAssignment = assignment.index;
    assignmentCount += 1;
  }
  if (assignmentCount >= dumpThreshold) {
    matches.push({
      rule: 'credential-dump',
      reason: `holds ${assignmentCount} credential assignments; the page is the credentials, not a memory about them`,
      line: lineOf(text, firstAssignment),
    });
  }

  const cards = new RegExp(CARD_CANDIDATE.source, CARD_CANDIDATE.flags);
  let card: RegExpExecArray | null;
  while ((card = cards.exec(text)) !== null) {
    const digits = card[0].replace(/[^0-9]/g, '');
    if (!luhnValid(digits)) continue;
    if (/^(\d)\1+$/.test(digits)) continue; // 4444444444444444 and friends
    matches.push({
      rule: 'payment-card',
      reason: 'contains a payment card number; no work memory has a reason to hold one',
      line: lineOf(text, card.index),
    });
    break;
  }

  return { blocked: matches.length > 0, matches };
}
