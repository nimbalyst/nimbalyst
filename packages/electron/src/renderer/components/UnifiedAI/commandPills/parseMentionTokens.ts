/**
 * Detect `@` file references and `@@[title](shortId)` session mentions inside a
 * textarea value so they can be rendered as tinted pills by the same overlay that
 * highlights `/command` tokens.
 *
 * Both forms only match at a boundary (column 0 or after whitespace), mirroring
 * the trigger rules in `extractTriggerMatch` (Typeahead/typeaheadUtils.ts). The
 * session form is matched BEFORE the lone `@` form so a `@@[...](...)` mention is
 * never mis-parsed as a bare `@` file ref. Emails (`a@b.com`) never match because
 * the `@` sits mid-word rather than at a boundary, and a lone `@` with no path
 * never matches because at least one non-`@`, non-whitespace character is
 * required after it.
 *
 * When `caretPos` sits inside (or at the end of) a token, that token is skipped so
 * a mention the user is still typing doesn't flicker into a pill while the
 * autocomplete is open — same suppression rule as `parseCommandTokens`.
 *
 * IMPORTANT: tokens keep a strict 1:1 character correspondence with the value
 * (start/end index the raw text). The overlay only tints them; it never collapses
 * `@@[title](id)` to a shorter label, which would desync the transparent caret.
 */
export interface MentionToken {
  /** Index of the leading `@` in the value. */
  start: number;
  /** Index one past the last character of the mention. */
  end: number;
  kind: 'fileMention' | 'sessionMention';
}

// Boundary (start or whitespace) captured separately so the `@` index can be
// derived. Session form first: `@@[...](...)` with a title that may contain
// spaces (but not `]` or newlines) and a short id (no `)` or newlines). File form
// second: `@` followed by at least one non-`@`, non-whitespace char, then any run
// of non-whitespace (paths contain `/`, `.`, `-`, etc.) up to the next whitespace.
const MENTION_TOKEN_REGEX = /(^|\s)(@@\[[^\]\n]*\]\([^)\n]*\)|@[^\s@]\S*)/g;

export function parseMentionTokens(
  value: string,
  caretPos?: number | null
): MentionToken[] {
  const tokens: MentionToken[] = [];
  if (!value) {
    return tokens;
  }

  const regex = new RegExp(MENTION_TOKEN_REGEX);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const boundary = match[1];
    const raw = match[2];
    const start = match.index + boundary.length;
    const end = start + raw.length;

    // Skip the token the caret is currently editing (collapsed caret only) so it
    // doesn't pill mid-keystroke while the typeahead is still open.
    if (caretPos != null && caretPos >= start && caretPos <= end) {
      continue;
    }

    const kind = raw.startsWith('@@') ? 'sessionMention' : 'fileMention';
    tokens.push({ start, end, kind });
  }

  return tokens;
}
