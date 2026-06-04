/**
 * Pure helpers for sanitizing and cleaning persisted terminal scrollback before
 * it is replayed into a fresh terminal instance.
 *
 * Extracted from TerminalPanel.tsx so they can be unit-tested without pulling in
 * the ghostty-web WASM module.
 */

/**
 * Strip escape sequences that can corrupt terminal state when replayed.
 *
 * When scrollback contains certain escape sequences and is written back to a fresh
 * terminal instance, these sequences can leave the terminal in a corrupted state
 * where old content appears mixed with new output.
 *
 * Problematic sequences include:
 * - Cursor save/restore (ESC 7, ESC 8, CSI s, CSI u)
 * - Scroll region settings (CSI r, CSI Ps;Ps r)
 * - Cursor position (CSI H, CSI Ps;Ps H, CSI f)
 * - Alternate screen buffer (CSI ?1049h/l, CSI ?47h/l, CSI ?1047h/l)
 * - Various DEC private modes that affect display
 */
export function stripProblematicEscapeSequences(raw: string): string {
  // Remove cursor save/restore sequences
  // ESC 7 (save) and ESC 8 (restore) - DEC sequences
  let result = raw.replace(/\x1b[78]/g, '');

  // Remove CSI cursor save/restore: CSI s and CSI u
  result = result.replace(/\x1b\[s/g, '');
  result = result.replace(/\x1b\[u/g, '');

  // Remove scroll region settings: CSI r or CSI Ps;Ps r
  // This matches ESC [ followed by optional numbers and semicolons, ending with 'r'
  result = result.replace(/\x1b\[\d*;?\d*r/g, '');

  // Remove absolute cursor positioning: CSI H, CSI f, CSI Ps;Ps H, CSI Ps;Ps f
  // These position the cursor at specific row/col which can cause issues
  result = result.replace(/\x1b\[\d*;?\d*[Hf]/g, '');

  // Remove alternate screen buffer switches
  // CSI ?1049h/l (alternate screen with save/restore cursor)
  // CSI ?47h/l (alternate screen)
  // CSI ?1047h/l (alternate screen, different variant)
  result = result.replace(/\x1b\[\?(1049|47|1047)[hl]/g, '');

  // Remove other problematic DEC private modes
  // CSI ?1h/l (cursor keys mode)
  // CSI ?25h/l (cursor visibility) - keep these as they're harmless
  // CSI ?7h/l (autowrap) - can cause issues
  result = result.replace(/\x1b\[\?7[hl]/g, '');

  return result;
}

/**
 * Clean up scrollback content before restoring to terminal.
 *
 * The raw PTY output often contains excessive whitespace from terminal width
 * padding (e.g., zsh's PROMPT_SP feature fills the rest of the line with spaces
 * then uses carriage return to go back). When restoring scrollback to a terminal
 * with a different width, these sequences cause visual issues.
 *
 * This function removes runs of whitespace that precede carriage returns,
 * as these are used by shells to "clear" the rest of a line by overwriting.
 */
export function cleanScrollback(raw: string): string {
  // Pattern explanation:
  // [ \t]+  - One or more spaces or tabs
  // \r      - Followed by carriage return (which moves cursor to line start)
  // (?!\n)  - Negative lookahead: NOT followed by newline (preserve \r\n)
  //
  // This specifically targets the pattern: "text... <spaces> \r <more content>"
  // which is zsh's technique for partial line markers
  return raw.replace(/[ \t]+\r(?!\n)/g, '\r');
}

/**
 * Sanitize scrollback data to remove invalid code points that could crash the terminal.
 *
 * When scrollback data gets corrupted (e.g., WASM memory issues, incomplete writes),
 * it may contain invalid code points outside the valid Unicode range (0x0 - 0x10FFFF).
 * The terminal's render loop will crash with "Invalid code point" errors when trying
 * to render these. This function validates each character and replaces invalid ones.
 *
 * NUL bytes also cause WASM memory access errors in Ghostty's parser, but they appear
 * legitimately in some PTY output, so they are stripped rather than treated as fatal.
 *
 * Returns null only if the data is severely corrupted (high density of suspicious
 * control characters, or >1% invalid code points), indicating the scrollback should
 * be discarded entirely.
 */
export function sanitizeScrollback(raw: string): string | null {
  // Strip NUL bytes rather than discarding the whole buffer. They carry no
  // display meaning and cause WASM memory errors in Ghostty's parser, but they
  // legitimately appear in some PTY output (TUI padding, shell completion
  // streams). Dropping them lets the rest of the history restore cleanly
  // instead of throwing away 500KB of valid scrollback over one stray NUL.
  // NUL density is NOT used as a corruption signal: a NUL-heavy stream (e.g.
  // `cat /dev/zero`) just strips down to whatever real text is around it, which
  // is harmless. Genuine binary corruption is caught by the un-strippable
  // control-character check below.
  let nullByteCount = 0;
  if (raw.includes('\x00')) {
    nullByteCount = (raw.match(/\x00/g) || []).length;
    raw = raw.replace(/\x00/g, '');
  }

  // Check for excessive unexpected control characters (outside of ESC sequences)
  // Control chars 0x01-0x06, 0x0E-0x1A (excluding common ones like \t, \n, \r, \x1b)
  // High density of these indicates binary corruption
  let suspiciousControlCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // Count control chars that shouldn't appear frequently in terminal output
    // 0x01-0x06 (SOH, STX, ETX, EOT, ENQ, ACK) and 0x0E-0x1A (SO, SI, DLE, etc.)
    // Exclude: 0x07 (BEL - used in escape sequences), 0x08 (BS), 0x09 (TAB),
    // 0x0A (LF), 0x0B (VT), 0x0C (FF), 0x0D (CR), 0x1B (ESC)
    if ((code >= 0x01 && code <= 0x06) || (code >= 0x0E && code <= 0x1A)) {
      suspiciousControlCount++;
    }
  }

  // If more than 0.5% are suspicious control characters, likely binary corruption
  const suspiciousRatio = raw.length > 0 ? suspiciousControlCount / raw.length : 0;
  if (suspiciousRatio > 0.005) {
    console.warn(
      `[TerminalPanel] Scrollback contains excessive control characters (${suspiciousControlCount}/${raw.length}, ${(suspiciousRatio * 100).toFixed(2)}%), discarding`
    );
    return null;
  }

  if (nullByteCount > 0) {
    console.warn(`[TerminalPanel] Stripped ${nullByteCount} NUL byte(s) from scrollback`);
  }

  const MAX_VALID_CODE_POINT = 0x10FFFF;
  let invalidCount = 0;
  let result = '';

  for (let i = 0; i < raw.length; i++) {
    const codePoint = raw.codePointAt(i);

    // Handle undefined (shouldn't happen but be safe)
    if (codePoint === undefined) {
      invalidCount++;
      continue;
    }

    // Check if code point is valid Unicode
    if (codePoint > MAX_VALID_CODE_POINT || codePoint < 0) {
      invalidCount++;
      // Replace invalid code point with Unicode replacement character
      result += '�';
      continue;
    }

    // For surrogate pairs (code points > 0xFFFF), we need to handle both chars
    if (codePoint > 0xFFFF) {
      result += String.fromCodePoint(codePoint);
      i++; // Skip the low surrogate
    } else {
      result += raw[i];
    }
  }

  // If more than 1% of characters are invalid, the data is severely corrupted
  const invalidRatio = raw.length > 0 ? invalidCount / raw.length : 0;
  if (invalidRatio > 0.01) {
    console.warn(
      `[TerminalPanel] Scrollback severely corrupted: ${invalidCount}/${raw.length} invalid characters (${(invalidRatio * 100).toFixed(1)}%)`
    );
    return null;
  }

  if (invalidCount > 0) {
    console.warn(`[TerminalPanel] Sanitized ${invalidCount} invalid code points from scrollback`);
  }

  return result;
}
