/**
 * Source-preserving writer for a markdown file's YAML frontmatter.
 *
 * Every tracker write used to `jsyaml.load` the header and `jsyaml.dump` it
 * back, so a one-field edit reserialized the whole header: comments vanished,
 * quoted scalars came back in a different style, and a bare `created:
 * 2026-09-19` was expanded to an ISO timestamp. These files live in git, so the
 * diff was far larger than the change (GitHub #1552).
 *
 * This module edits the header's *source text*. Callers describe what they want
 * changed as a list of ops; each op is applied by splicing the affected value's
 * source range, so any byte no op names is passed through untouched. A key that
 * does not exist yet is appended; a key whose new value already matches the one
 * on disk is skipped entirely.
 *
 * It refuses to write rather than guess. A header that is unterminated,
 * unparsable, not a mapping, a flow mapping at the root, or that uses anchors /
 * aliases / non-string keys in a region an op would touch throws
 * `FrontmatterWriteError` instead of returning content. Every caller evaluates
 * the writer before its own `writeFile`, so the throw stops the write from
 * happening at all and the file on disk is left exactly as it was -- where
 * previously such a header was silently treated as `{}` and overwritten.
 */

import jsyaml from 'js-yaml';
import {
  Document,
  isMap,
  isScalar,
  parseDocument,
  visit,
  type Node,
  type Pair,
  type Scalar,
} from 'yaml';

export type FrontmatterOp =
  | {
      kind: 'set';
      key: string;
      value: unknown;
      /**
       * Marks a value the tracker stamps as policy (`created` / `updated`)
       * rather than one a caller asked for. Only these compare date-equal to an
       * existing bare `2026-09-19` node, so re-stamping today's date over the
       * date already in the file is a no-op instead of a rewrite. A caller
       * writing `updated` explicitly still gets its exact value and type.
       */
      timestamp?: boolean;
    }
  | { kind: 'delete'; key: string };

export class FrontmatterWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterWriteError';
  }
}

/**
 * `---\n`, the header body, `---`, trailing newline. The body is optional so an
 * empty header (`---\n---\n`) is recognised and written into rather than being
 * mistaken for an unterminated one; when present it is always newline-terminated.
 */
const HEADER_REGEX = /^---(\r?\n)((?:[\s\S]*?\r?\n)?)---(\r?\n|$)/;

interface Splice {
  start: number;
  end: number;
  text: string;
}

export function applyFrontmatterOps(content: string, rawOps: FrontmatterOp[]): string {
  const ops = collapseOps(rawOps);
  const match = content.match(HEADER_REGEX);
  if (!match) {
    if (/^---\r?\n/.test(content)) {
      throw new FrontmatterWriteError(
        'File opens with `---` but has no terminated frontmatter header; refusing to rewrite it.',
      );
    }
    return createHeader(content, ops);
  }

  const [whole, openerNewline, headerSrc, closingNewline] = match;
  const newline = headerSrc.includes('\r\n') || openerNewline === '\r\n' ? '\r\n' : '\n';
  const body = content.slice(whole.length);

  const nextHeader = rewriteHeader(headerSrc, ops, newline);
  return `---${openerNewline}${nextHeader}---${closingNewline}${body}`;
}

/**
 * One op per key: the last write wins, at the position of the first mention.
 *
 * Callers legitimately name a key twice -- the tracker applies the caller's
 * updates and then stamps its own `updated` / `trackerStatus` over them, which
 * the old single-object merge resolved as last-write-wins. Two live ops for one
 * key would instead splice the same source range twice, which is a refusal.
 */
function collapseOps(ops: FrontmatterOp[]): FrontmatterOp[] {
  const collapsed: FrontmatterOp[] = [];
  const positionOf = new Map<string, number>();
  for (const op of ops) {
    const seen = positionOf.get(op.key);
    if (seen === undefined) {
      positionOf.set(op.key, collapsed.length);
      collapsed.push(op);
    } else {
      collapsed[seen] = op;
    }
  }
  return collapsed;
}

/** Prepend a header to a file that has none. Matches the previous behaviour. */
function createHeader(content: string, ops: FrontmatterOp[]): string {
  const mapping: Record<string, unknown> = {};
  for (const op of ops) {
    if (op.kind === 'set') mapping[op.key] = op.value;
  }
  return `---\n${render(mapping)}---\n${content}`;
}

function rewriteHeader(headerSrc: string, ops: FrontmatterOp[], newline: string): string {
  if (ops.length === 0) return headerSrc;

  const doc = parseDocument(headerSrc, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    throw new FrontmatterWriteError(
      `Frontmatter does not parse as YAML (${doc.errors[0].message}); refusing to rewrite it.`,
    );
  }

  // A comment-only or empty header parses to no contents. That is writable:
  // every op is an append.
  const root = doc.contents == null ? null : doc.contents;
  if (root !== null && !isMap(root)) {
    throw new FrontmatterWriteError(
      'Frontmatter is not a YAML mapping; refusing to rewrite it.',
    );
  }
  if (root && root.flow) {
    throw new FrontmatterWriteError(
      'Frontmatter uses a flow mapping at the root; refusing to rewrite it.',
    );
  }

  const pairs = (root?.items ?? []) as Pair<unknown, unknown>[];
  const byKey = new Map<string, Pair<unknown, unknown>>();
  for (const pair of pairs) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      throw new FrontmatterWriteError(
        'Frontmatter uses a non-string key; refusing to rewrite it.',
      );
    }
    const key = pair.key.value;
    if (byKey.has(key)) {
      throw new FrontmatterWriteError(
        `Frontmatter defines \`${key}\` more than once; refusing to rewrite it.`,
      );
    }
    byKey.set(key, pair);
  }

  // Compare against what the js-yaml reader sees, because that is the value the
  // caller's update was computed from. `yaml` resolves a bare date to a string
  // where js-yaml resolves it to a Date.
  const readerValues = loadHeaderWithReader(headerSrc);

  const splices: Splice[] = [];
  const appended: string[] = [];
  const applied: FrontmatterOp[] = [];

  for (const op of ops) {
    const pair = byKey.get(op.key);

    if (op.kind === 'delete') {
      if (!pair) continue;
      assertRewritable(op.key, pair);
      splices.push(deleteSplice(headerSrc, pair));
      byKey.delete(op.key);
      applied.push(op);
      continue;
    }

    if (op.value === undefined) continue; // callers translate undefined to a delete
    if (pair) {
      // An op that changes nothing touches nothing, so it is skipped before the
      // rewritability guards run. A caller rehearsing a write to find out
      // whether the header would accept it must therefore use a value that
      // differs from what the file already says, or it rehearses a no-op.
      if (valueIsUnchanged(readerValues[op.key], op.value, op.timestamp === true)) continue;
      assertRewritable(op.key, pair);
      splices.push(setSplice(headerSrc, pair, op.value, newline));
    } else {
      appended.push(renderPair(op.key, op.value, newline));
    }
    applied.push(op);
  }

  if (splices.length === 0 && appended.length === 0) return headerSrc;

  let next = applySplices(headerSrc, splices);
  if (appended.length > 0) {
    if (next.length > 0 && !/\r?\n$/.test(next)) next += newline;
    next += appended.join('');
  }

  verifyRewrite(next, applied, readerValues);
  return next;
}

/** Apply non-overlapping splices back-to-front so earlier offsets stay valid. */
function applySplices(source: string, splices: Splice[]): string {
  const ordered = [...splices].sort((a, b) => b.start - a.start);
  let previousStart = Number.POSITIVE_INFINITY;
  let out = source;
  for (const splice of ordered) {
    if (splice.end > previousStart) {
      throw new FrontmatterWriteError('Overlapping frontmatter edits; refusing to rewrite.');
    }
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
    previousStart = splice.start;
  }
  return out;
}

/**
 * Anchors and aliases cannot survive a partial rewrite: replacing or deleting a
 * subtree that defines an anchor leaves every alias to it dangling, and an
 * alias we replace loses the sharing the author wrote. Untouched anchors
 * elsewhere in the header are fine -- they are never re-serialized.
 */
function assertRewritable(key: string, pair: Pair<unknown, unknown>): void {
  for (const node of [pair.key, pair.value]) {
    if (node == null) continue;
    let found = false;
    visit(node as Node, {
      Alias() {
        found = true;
        return visit.BREAK;
      },
      Node(_key, current) {
        if ((current as { anchor?: string }).anchor) {
          found = true;
          return visit.BREAK;
        }
        return undefined;
      },
    });
    if (found) {
      throw new FrontmatterWriteError(
        `Frontmatter key \`${key}\` uses a YAML anchor or alias; refusing to rewrite it.`,
      );
    }
  }
}

function lineStart(source: string, index: number): number {
  return source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
}

/** Offset just past the `:` that separates a pair's key from its value. */
function colonEnd(source: string, pair: Pair<unknown, unknown>): number {
  const keyEnd = (pair.key as Scalar).range?.[1] ?? 0;
  const colon = source.indexOf(':', keyEnd);
  if (colon < 0) {
    throw new FrontmatterWriteError('Frontmatter pair has no `:` separator; refusing to rewrite.');
  }
  return colon + 1;
}

function setSplice(
  source: string,
  pair: Pair<unknown, unknown>,
  value: unknown,
  newline: string,
): Splice {
  const separator = colonEnd(source, pair);
  const valueNode = pair.value as Node | null;

  // `key:` with no value at all -- write straight after the colon, stopping
  // short of a comment on the same line.
  if (valueNode == null || !valueNode.range) {
    const keyLine = lineStart(source, (pair.key as Scalar).range![0]);
    const keyIndent = (pair.key as Scalar).range![0] - keyLine;
    const lineEnd = endOfLine(source, separator);
    const comment = source.indexOf('#', separator);
    const end = comment >= 0 && comment < lineEnd ? comment : lineEnd;
    const text = inlineText(value, keyIndent, newline) + (end === comment ? ' ' : '');
    return { start: separator, end, text };
  }

  const [valueStart, valueEnd] = valueNode.range;
  const gap = source.slice(separator, valueStart);
  const region = source.slice(valueStart, valueEnd);
  const trailingNewline = /\r?\n$/.exec(region)?.[0] ?? '';

  // A comment between the colon and the value (`tags: # why\n  - a`) is the
  // author's; keep it and replace only the value, at its own column.
  if (gap.includes('#')) {
    const column = valueStart - lineStart(source, valueStart);
    const lines = renderLines(value, scalarStyleToReuse(valueNode, value));
    const text = lines.map((line, i) => (i === 0 ? line : ' '.repeat(column) + line)).join(newline);
    return { start: valueStart, end: valueEnd, text: text + trailingNewline };
  }

  const keyLine = lineStart(source, (pair.key as Scalar).range![0]);
  const keyIndent = (pair.key as Scalar).range![0] - keyLine;
  const reusedStyle = scalarStyleToReuse(valueNode, value);
  return {
    start: separator,
    end: valueEnd,
    text: inlineText(value, keyIndent, newline, reusedStyle) + trailingNewline,
  };
}

/**
 * Render a value as it should appear after `key:`. Block collections start on
 * the next line; everything else (including block scalars, whose `|-` header
 * must stay on the key's line) starts inline.
 */
function inlineText(
  value: unknown,
  keyIndent: number,
  newline: string,
  stringType?: Scalar.Type,
): string {
  const lines = renderLines(value, stringType);
  const childIndent = ' '.repeat(keyIndent + 2);
  if (isCollectionValue(value) && lines.length > 0) {
    return newline + lines.map(line => childIndent + line).join(newline);
  }
  return lines.map((line, i) => (i === 0 ? ` ${line}` : childIndent + line)).join(newline);
}

function renderLines(value: unknown, stringType?: Scalar.Type): string[] {
  return render(value, stringType).replace(/\n+$/, '').split('\n');
}

function isCollectionValue(value: unknown): boolean {
  if (value == null || value instanceof Date) return false;
  return Array.isArray(value) || typeof value === 'object';
}

/**
 * Keep the quoting style the author used when swapping one string for another,
 * so `owner: "a.contributor"` becomes `owner: "b.maintainer"` rather than
 * changing shape. Block scalars are excluded -- their indentation is source
 * layout, not style.
 */
function scalarStyleToReuse(valueNode: Node, next: unknown): Scalar.Type | undefined {
  if (typeof next !== 'string') return undefined;
  if (!isScalar(valueNode) || typeof valueNode.value !== 'string') return undefined;
  if (valueNode.type === 'QUOTE_DOUBLE' || valueNode.type === 'QUOTE_SINGLE') return valueNode.type;
  return undefined;
}

function endOfLine(source: string, from: number): number {
  const index = source.indexOf('\n', from);
  return index < 0 ? source.length : index;
}

function deleteSplice(source: string, pair: Pair<unknown, unknown>): Splice {
  const keyRange = (pair.key as Scalar).range!;
  const start = lineStart(source, keyRange[0]);
  const valueNode = pair.value as Node | null;
  let end = valueNode?.range ? valueNode.range[2] : endOfLine(source, keyRange[2]);
  // A comment line above the key belongs to the human, not to the key -- leave
  // it. The pair's own trailing newline goes with the pair.
  if (!/\n$/.test(source.slice(start, end))) {
    const newlineIndex = source.indexOf('\n', end);
    end = newlineIndex < 0 ? source.length : newlineIndex + 1;
  }
  return { start, end, text: '' };
}

function renderPair(key: string, value: unknown, newline: string): string {
  return render({ [key]: value }).replace(/\n/g, newline);
}

/**
 * Serialize a value, then confirm the **js-yaml** reader gets it back
 * unchanged. `yaml` follows the YAML 1.2 core schema and will happily emit a
 * bare `2026-09-19` or `yes` for a string, which js-yaml then resolves to a Date
 * or (for other spellings) a non-string. Quoting is the fallback.
 */
function render(value: unknown, stringType?: Scalar.Type): string {
  const preferred = stringify(value, stringType);
  if (readsBackAs(preferred, value)) return preferred;
  // Single quotes first: that is what these headers have been written with for
  // as long as they were dumped by js-yaml, so an existing file keeps its look.
  for (const fallback of ['QUOTE_SINGLE', 'QUOTE_DOUBLE'] as const) {
    if (fallback === stringType) continue;
    const quoted = stringify(value, fallback);
    if (readsBackAs(quoted, value)) return quoted;
  }
  throw new FrontmatterWriteError(
    'Value cannot be written as YAML that reads back unchanged; refusing to rewrite.',
  );
}

function stringify(value: unknown, stringType?: Scalar.Type): string {
  const doc = new Document(value);
  // `defaultStringType` is omitted rather than passed as undefined unless a
  // style is being reused: yaml rejects an explicit undefined, and its own
  // default keeps a multi-line string a block scalar instead of a quoted
  // multi-line one.
  return doc.toString({
    indent: 2,
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
    ...(stringType ? { defaultStringType: stringType } : {}),
  });
}

/**
 * Read the rendered text back the way it will actually appear: as the value of
 * a key. A block scalar is only legal there -- js-yaml rejects `|-` at the root
 * of a document -- so checking the bare text would reject every block scalar
 * and fall back to quoting it.
 */
function readsBackAs(text: string, value: unknown): boolean {
  const lines = text.replace(/\n+$/, '').split('\n');
  const wrapped = isCollectionValue(value)
    ? `_:\n${lines.map(line => `  ${line}`).join('\n')}\n`
    : `_: ${lines.map((line, i) => (i === 0 ? line : `\n  ${line}`)).join('')}\n`;
  let loaded: unknown;
  try {
    loaded = jsyaml.load(wrapped);
  } catch {
    return false;
  }
  const read = (loaded as Record<string, unknown> | null)?._;
  return deepEqual(read ?? null, value ?? null);
}

function loadHeaderWithReader(headerSrc: string): Record<string, unknown> {
  let loaded: unknown;
  try {
    loaded = jsyaml.load(headerSrc);
  } catch (error) {
    throw new FrontmatterWriteError(
      `Frontmatter does not parse as YAML (${error instanceof Error ? error.message : String(error)}); refusing to rewrite it.`,
    );
  }
  if (loaded == null) return {};
  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new FrontmatterWriteError(
      'Frontmatter is not a YAML mapping; refusing to rewrite it.',
    );
  }
  return loaded as Record<string, unknown>;
}

/**
 * Re-read the header we produced and prove it says what we meant: every op
 * landed, and every key no op named still reads back exactly as it did before.
 * This is the backstop for constructs whose source layout this module does not
 * model -- it fails the write instead of shipping a corrupted header.
 */
function verifyRewrite(
  after: string,
  applied: FrontmatterOp[],
  readerValues: Record<string, unknown>,
): void {
  const reparsed = parseDocument(after);
  if (reparsed.errors.length > 0) {
    throw new FrontmatterWriteError(
      `Rewritten frontmatter would not parse (${reparsed.errors[0].message}); refusing to write it.`,
    );
  }
  const next = loadHeaderWithReader(after);

  const touched = new Set(applied.map(op => op.key));
  for (const [key, value] of Object.entries(readerValues)) {
    if (touched.has(key)) continue;
    if (!deepEqual(next[key], value)) {
      throw new FrontmatterWriteError(
        `Rewriting frontmatter would have changed the untouched key \`${key}\`; refusing to write it.`,
      );
    }
  }
  for (const op of applied) {
    if (op.kind === 'delete') {
      if (Object.prototype.hasOwnProperty.call(next, op.key)) {
        throw new FrontmatterWriteError(
          `Failed to remove \`${op.key}\` from frontmatter; refusing to write it.`,
        );
      }
      continue;
    }
    if (!valueIsUnchanged(next[op.key], op.value, op.timestamp === true)) {
      throw new FrontmatterWriteError(
        `Rewritten frontmatter does not read back \`${op.key}\` as written; refusing to write it.`,
      );
    }
  }
}

/**
 * `allowSameDay` only applies to tracker-stamped timestamps: a bare
 * `created: 2026-09-19` reads back as a Date, and re-stamping the same calendar
 * day must not rewrite the node. Every other comparison is exact, so a caller
 * that deliberately writes the string `'2026-09-19'` over a Date still gets the
 * string.
 */
function valueIsUnchanged(current: unknown, next: unknown, allowSameDay: boolean): boolean {
  if (deepEqual(current, next)) return true;
  if (!allowSameDay) return false;
  const a = asCalendarDay(current);
  const b = asCalendarDay(next);
  return a != null && a === b;
}

/**
 * The calendar day a value denotes, or null if it denotes an instant rather
 * than a day. js-yaml resolves a bare `2026-09-19` node to UTC midnight, so a
 * Date qualifies only when it lands exactly on a UTC day boundary -- anything
 * carrying a time of day is a different kind of value and never compares equal.
 */
function asCalendarDay(value: unknown): string | null {
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time) || time % 86_400_000 !== 0) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    key =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
