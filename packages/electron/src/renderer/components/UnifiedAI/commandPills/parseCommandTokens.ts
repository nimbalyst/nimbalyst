/**
 * Detect slash-command tokens (`/command-name`) inside a textarea value so they
 * can be rendered as pills. Mirrors the trigger rules in `extractTriggerMatch`
 * (Typeahead/typeaheadUtils.ts): a token starts at column 0 or after whitespace,
 * the name is a run of non-whitespace / non-slash characters, and the token ends
 * at whitespace or end-of-input. Path-like values (`/Users/me`) never match
 * because the name cannot contain a slash and must be followed by whitespace/EOL.
 *
 * Only names present in `knownNames` are emitted, so an unknown `/foo` stays
 * plain text. When `caretPos` sits inside (or at the end of) a token, that token
 * is skipped so a command the user is still typing doesn't flicker into a pill
 * while the autocomplete is open.
 */
export interface CommandToken {
  /** Index of the leading slash in the value. */
  start: number;
  /** Index one past the last character of the name. */
  end: number;
  /** Command name without the leading slash. */
  name: string;
}

// Capture the boundary (start or whitespace) separately so the slash index can
// be derived; `[^\s/]+` keeps names slash-free, and the lookahead requires the
// token to end at whitespace or end-of-input.
const COMMAND_TOKEN_REGEX = /(^|\s)\/([^\s/]+)(?=\s|$)/g;

export function parseCommandTokens(
  value: string,
  knownNames: ReadonlySet<string>,
  caretPos?: number | null
): CommandToken[] {
  const tokens: CommandToken[] = [];
  if (!value || knownNames.size === 0) {
    return tokens;
  }

  const regex = new RegExp(COMMAND_TOKEN_REGEX);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const name = match[2];
    if (!knownNames.has(name)) {
      continue;
    }
    const start = match.index + match[1].length;
    const end = start + 1 + name.length; // leading slash + name

    // Skip the token the caret is currently editing (collapsed caret only) so
    // it doesn't pill mid-keystroke while the typeahead is still open.
    if (caretPos != null && caretPos >= start && caretPos <= end) {
      continue;
    }

    tokens.push({ start, end, name });
  }

  return tokens;
}
