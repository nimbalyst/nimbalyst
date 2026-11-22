/**
 * Readable text from raw PTY output, and cursor-based reads over a terminal's
 * scrollback. Shared by every agent-facing terminal read (`run_logs` through
 * `ctx.services.terminals`, and the planned `terminal_read`).
 *
 * Raw scrollback is bytes with color codes, cursor moves and `\r` progress
 * bars. `renderTerminalText` strips the escape sequences and replays the
 * in-line overwrites, so a progress bar collapses to its last frame instead of
 * hundreds of them. It is not a terminal emulator: cursor movement between
 * lines is ignored and full-screen (alternate screen) programs are dropped.
 *
 * Cursors are absolute offsets into everything a terminal has ever written
 * (UTF-16 code units, the unit of the scrollback string). The scrollback is
 * trimmed from the front at its size cap, so a reader keeps the number of
 * trimmed units (`base`) next to the buffer; a cursor that fell off the front
 * reads what is left and reports `gap`.
 */

const ESC = '\x1b';
const ALT_SCREEN_MODES = new Set(['47', '1047', '1049']);
const ALT_SCREEN_NOTE = '[full-screen program output omitted]';
/** Widest column a cursor-positioning sequence may move to. */
const MAX_RENDERED_COLUMN = 2000;

/** Default cap on rendered text returned by one read; the tail is kept. */
export const DEFAULT_TERMINAL_READ_MAX_CHARS = 20_000;
export const DEFAULT_TERMINAL_TAIL_LINES = 100;

/**
 * Strip ANSI/OSC sequences, apply `\r`, backspace and erase-in-line, and drop
 * alternate-screen spans.
 */
export function renderTerminalText(raw: string): string {
  const lines: string[] = [];
  let line: string[] = [];
  let col = 0;
  let inAltScreen = false;

  const put = (ch: string) => {
    if (inAltScreen) return;
    while (line.length < col) line.push(' ');
    line[col] = ch;
    col += 1;
  };
  const newline = () => {
    if (inAltScreen) return;
    lines.push(line.join('').replace(/\s+$/, ''));
    line = [];
    col = 0;
  };

  let i = 0;
  const length = raw.length;
  while (i < length) {
    const ch = raw[i];

    if (ch === ESC) {
      const next = raw[i + 1];
      if (next === '[') {
        // CSI: parameters 0x30-0x3f, intermediates 0x20-0x2f, one final byte 0x40-0x7e.
        let j = i + 2;
        while (j < length && raw.charCodeAt(j) >= 0x30 && raw.charCodeAt(j) <= 0x3f) j += 1;
        const params = raw.slice(i + 2, j);
        while (j < length && raw.charCodeAt(j) >= 0x20 && raw.charCodeAt(j) <= 0x2f) j += 1;
        if (j >= length) break; // Incomplete sequence at the end of the chunk.
        const final = raw[j];
        if ((final === 'h' || final === 'l') && params.startsWith('?')) {
          const modes = params.slice(1).split(';');
          if (modes.some((mode) => ALT_SCREEN_MODES.has(mode))) {
            const entering = final === 'h';
            if (entering && !inAltScreen) {
              if (line.length > 0) newline();
              lines.push(ALT_SCREEN_NOTE);
            }
            inAltScreen = entering;
          }
        } else if (final === 'K' && !inAltScreen) {
          const mode = params === '' ? '0' : params;
          if (mode === '0') line.length = Math.min(line.length, col);
          else if (mode === '1') for (let k = 0; k < Math.min(col, line.length); k += 1) line[k] = ' ';
          else if (mode === '2') line = [];
        } else if (final === 'G' && !inAltScreen) {
          // Cursor to column N (1-based); spinners use it instead of `\r`.
          const target = Number.parseInt(params || '1', 10);
          // Capped: the next character pads the line out to this column.
          col = Number.isFinite(target) ? Math.min(MAX_RENDERED_COLUMN, Math.max(0, target - 1)) : 0;
        }
        i = j + 1;
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC / DCS / APC / PM / SOS: a string ended by BEL or ST (ESC \).
        let j = i + 2;
        let ended = false;
        while (j < length) {
          if (raw[j] === '\x07') {
            j += 1;
            ended = true;
            break;
          }
          if (raw[j] === ESC && raw[j + 1] === '\\') {
            j += 2;
            ended = true;
            break;
          }
          j += 1;
        }
        if (!ended) break;
        i = j;
        continue;
      }
      if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') {
        i += 3; // Charset designation and friends carry one more byte.
        continue;
      }
      if (next === undefined) break;
      i += 2; // Any other two-byte escape (ESC =, ESC >, ESC M, ...).
      continue;
    }

    if (ch === '\n') {
      newline();
    } else if (ch === '\r') {
      col = 0;
    } else if (ch === '\b') {
      col = Math.max(0, col - 1);
    } else if (ch === '\t') {
      // `put` writes nothing inside an alternate-screen span, so the column
      // would never reach the stop there.
      if (!inAltScreen) {
        const stop = (Math.floor(col / 8) + 1) * 8;
        while (col < stop) put(' ');
      }
    } else if (ch.charCodeAt(0) >= 0x20 && ch !== '\x7f') {
      put(ch);
    }
    // Remaining C0 controls (BEL, NUL, ...) are dropped.
    i += 1;
  }

  const last = line.join('').replace(/\s+$/, '');
  if (last.length > 0 && !inAltScreen) lines.push(last);
  return lines.join('\n');
}

/** A terminal's scrollback plus how much was trimmed off its front. */
export interface TerminalOutputState {
  buffer: string;
  /** Code units trimmed from the front of `buffer` since the terminal started. */
  base: number;
}

export interface TerminalReadOptions {
  /** Last N rendered lines. Used when `since` is absent. */
  tail?: number;
  /** Output written after this cursor (a `cursor` from an earlier read). */
  since?: number;
  maxChars?: number;
}

export interface TerminalReadResult {
  text: string;
  /** Pass as `since` to read only what is written after this read. */
  cursor: number;
  /** The text was cut to `maxChars`, keeping the end. */
  truncated: boolean;
  /** `since` pointed at output that has already been trimmed away. */
  gap: boolean;
}

export function readTerminalOutput(
  state: TerminalOutputState,
  options: TerminalReadOptions = {}
): TerminalReadResult {
  const end = state.base + state.buffer.length;
  const maxChars = options.maxChars ?? DEFAULT_TERMINAL_READ_MAX_CHARS;
  let text: string;
  let gap = false;

  if (typeof options.since === 'number' && Number.isFinite(options.since)) {
    const since = Math.max(0, Math.floor(options.since));
    gap = since < state.base;
    // A cursor past the end belongs to an earlier run of the same target.
    const from = since > end ? 0 : Math.max(0, since - state.base);
    text = renderTerminalText(state.buffer.slice(from));
  } else {
    const requested = options.tail ?? DEFAULT_TERMINAL_TAIL_LINES;
    const count = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_TERMINAL_TAIL_LINES;
    text = renderTerminalText(state.buffer).split('\n').slice(-count).join('\n');
  }

  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(-maxChars);
    truncated = true;
  }
  return { text, cursor: end, truncated, gap };
}
