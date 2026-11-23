/**
 * Writes a hook document back into the file text. Only the parts of "hooks"
 * that changed get new text. Every other byte stays as it was.
 *
 * jsonc-parser's modify works out one text edit for one JSON path, and lays
 * out new text with the file's own indent and line ends. The writer walks the
 * old and the new "hooks" values side by side and asks for an edit only where
 * they differ. A removal cuts the old text out, and a move copies the old text
 * of the moved item, so the hooks around them keep every byte.
 */

import { diffLines } from 'diff';
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type FormattingOptions,
  type JSONPath,
  type Node,
} from 'jsonc-parser';

import type { HookDocument } from './hookDocument';
import { isJsonObject, type JsonObject, type JsonValue } from './types';

export interface WriteBase {
  /** The text on disk: the opened text, or the saved text after a save. */
  text: string;
  /** The hook pack script texts on disk. */
  scripts: Readonly<Record<string, string>>;
}

export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface WriteResult {
  text: string;
  /** For each line of `text`, the id of the smallest block on it, or null. */
  lineMap: Array<string | null>;
  diff: { added: number; changed: number; removed: number; parts: DiffPart[] };
  /** Hook pack scripts that are new or changed since the base. */
  scriptWrites: Array<{ path: string; text: string }>;
}

export function baseOf(text: string, doc: HookDocument): WriteBase {
  return { text, scripts: doc.scripts };
}

/** The file's line end and indent. A file with no indented line gets 2 spaces. */
export function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';
  return indent.startsWith('\t')
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setAt(
  text: string,
  path: JSONPath,
  value: JsonValue | undefined,
  formattingOptions: FormattingOptions,
  isArrayInsertion = false,
): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions, isArrayInsertion }));
}

function nodeAt(text: string, path: JSONPath): Node {
  const root = parseTree(text);
  const node = root ? findNodeAtLocation(root, path) : undefined;
  if (node === undefined) throw new Error(`The hook writer found no JSON value at ${path.join('.')}.`);
  return node;
}

/** Cuts one array item or object property out of the text, with no new layout. */
function removeAt(text: string, path: JSONPath): string {
  const value = nodeAt(text, path);
  const node = value.parent?.type === 'property' ? value.parent : value;
  const container = node.parent;
  if (container === undefined) throw new Error('The hook writer cannot remove the whole file.');
  const siblings = container.children ?? [];
  const next = siblings[siblings.indexOf(node) + 1];
  const previous = siblings[siblings.indexOf(node) - 1];
  // Cut up to the next item, or back to the end of the item before, so the
  // space and line end around the cut belong to a neighbour that stays.
  const [start, end] = next
    ? [node.offset, next.offset]
    : previous
      ? [previous.offset + previous.length, node.offset + node.length]
      : [container.offset + 1, container.offset + container.length - 1];
  return text.slice(0, start) + text.slice(end);
}

/**
 * Puts one new item into an array at the indent of the item beside it. The
 * items around it keep every byte. An empty or one-line array goes to
 * jsonc-parser for its layout.
 */
function insertAt(text: string, path: JSONPath, index: number, value: JsonValue, formatting: FormattingOptions): string {
  const items = nodeAt(text, path).children ?? [];
  const neighbour = items[Math.min(index, items.length - 1)];
  const lead = neighbour ? text.slice(text.lastIndexOf('\n', neighbour.offset) + 1, neighbour.offset) : '';
  if (!neighbour || lead.trim() !== '') return setAt(text, [...path, index], value, formatting, true);
  const eol = formatting.eol ?? '\n';
  const unit = formatting.insertSpaces ? ' '.repeat(formatting.tabSize ?? 2) : '\t';
  const item = JSON.stringify(value, null, unit).split('\n').join(eol + lead);
  if (index < items.length) return text.slice(0, neighbour.offset) + `${item},${eol}${lead}` + text.slice(neighbour.offset);
  const end = neighbour.offset + neighbour.length;
  return text.slice(0, end) + `,${eol}${lead}${item}` + text.slice(end);
}

/**
 * An array that keeps its length. A slot that now holds an item from another
 * slot gets that item's old text. Any other changed slot is written in place.
 */
function writeSlots(
  text: string,
  path: JSONPath,
  before: JsonValue[],
  after: JsonValue[],
  formatting: FormattingOptions,
): string {
  const oldText = (nodeAt(text, path).children ?? []).map((item) => text.slice(item.offset, item.offset + item.length));
  let out = text;
  // From the last slot back, so the offsets of the slots before stay right.
  for (let i = after.length - 1; i >= 0; i -= 1) {
    if (sameJson(before[i], after[i])) continue;
    const from = before.findIndex((value) => sameJson(value, after[i]));
    if (from === -1) {
      out = writeValue(out, [...path, i], before[i], after[i], formatting);
      continue;
    }
    const slot = nodeAt(out, [...path, i]);
    out = out.slice(0, slot.offset) + oldText[from] + out.slice(slot.offset + slot.length);
  }
  return out;
}

/** The first index where two arrays differ. */
function firstDifference(before: JsonValue[], after: JsonValue[]): number {
  let index = 0;
  while (index < before.length && index < after.length && sameJson(before[index], after[index])) index += 1;
  return index;
}

/**
 * Turns the value at `path` from `before` into `after` with the fewest text
 * edits. Objects go key by key. An array with one item added or removed gets
 * one insertion or one removal, and an array of the same length goes slot by
 * slot. Anything else is replaced whole.
 */
function writeValue(
  text: string,
  path: JSONPath,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  formatting: FormattingOptions,
): string {
  if (sameJson(before, after)) return text;
  if (isJsonObject(before) && isJsonObject(after)) {
    let out = text;
    for (const key of Object.keys(before)) {
      if (!(key in after)) out = removeAt(out, [...path, key]);
    }
    for (const [key, value] of Object.entries(after)) {
      out = writeValue(out, [...path, key], before[key], value, formatting);
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const index = firstDifference(before, after);
    if (after.length === before.length) return writeSlots(text, path, before, after, formatting);
    if (after.length === before.length + 1 && sameJson(before.slice(index), after.slice(index + 1))) {
      return insertAt(text, path, index, after[index], formatting);
    }
    if (after.length === before.length - 1 && sameJson(before.slice(index + 1), after.slice(index))) {
      return removeAt(text, [...path, index]);
    }
  }
  return setAt(text, path, after, formatting);
}

function rootOf(text: string): JsonObject {
  const root: unknown = text.trim() === '' ? {} : JSON.parse(text);
  return isJsonObject(root) ? root : {};
}

/** For each line, the id of the smallest event, group or hook range that holds the line's first character. */
function lineMapOf(text: string): Array<string | null> {
  const ranges: Array<{ start: number; end: number; id: string }> = [];
  const root = parseTree(text);
  const hooksNode = root ? findNodeAtLocation(root, ['hooks']) : undefined;
  for (const property of hooksNode?.type === 'object' ? (hooksNode.children ?? []) : []) {
    const [keyNode, groupsNode] = property.children ?? [];
    if (!keyNode || !groupsNode) continue;
    const event = String(keyNode.value);
    ranges.push({ start: property.offset, end: property.offset + property.length, id: event });
    if (groupsNode.type !== 'array') continue;
    (groupsNode.children ?? []).forEach((group, groupIndex) => {
      ranges.push({ start: group.offset, end: group.offset + group.length, id: `${event}/${groupIndex}` });
      const entries = group.type === 'object' ? findNodeAtLocation(group, ['hooks']) : undefined;
      if (entries?.type !== 'array') return;
      (entries.children ?? []).forEach((entry, hookIndex) => {
        ranges.push({ start: entry.offset, end: entry.offset + entry.length, id: `${event}/${groupIndex}/${hookIndex}` });
      });
    });
  }
  const map: Array<string | null> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const first = offset + (line.length - line.trimStart().length);
    let best: { start: number; end: number; id: string } | null = null;
    for (const range of ranges) {
      const holds = first >= range.start && first < range.end;
      if (holds && (best === null || range.end - range.start < best.end - best.start)) best = range;
    }
    map.push(best === null ? null : best.id);
    offset += line.length + 1;
  }
  return map;
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** A line diff. A removed run followed by an added run counts as changed lines, as far as they pair up. */
function diffOf(before: string, after: string): WriteResult['diff'] {
  const parts: DiffPart[] = diffLines(before, after).map((part) => ({
    kind: part.added ? 'added' : part.removed ? 'removed' : 'same',
    text: part.value,
  }));
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const lines = lineCount(parts[i].text);
    if (parts[i].kind === 'added') added += lines;
    if (parts[i].kind !== 'removed') continue;
    const next = parts[i + 1];
    if (next?.kind === 'added') {
      const nextLines = lineCount(next.text);
      const paired = Math.min(lines, nextLines);
      changed += paired;
      removed += lines - paired;
      added += nextLines - paired;
      i += 1;
    } else {
      removed += lines;
    }
  }
  return { added, changed, removed, parts };
}

export function writeDocument(base: WriteBase, doc: HookDocument): WriteResult {
  const before = rootOf(base.text).hooks;
  // A file with no hooks, and a document whose hooks are all gone again: write nothing.
  const after =
    before === undefined && isJsonObject(doc.hooks) && Object.keys(doc.hooks).length === 0 ? undefined : doc.hooks;
  let text = base.text;
  if (!sameJson(before, after)) {
    const start = base.text.trim() === '' ? '{}' : base.text;
    text = writeValue(start, ['hooks'], before, after, detectFormatting(start));
  }
  const scriptWrites = Object.entries(doc.scripts)
    .filter(([path, scriptText]) => base.scripts[path] !== scriptText)
    .map(([path, scriptText]) => ({ path, text: scriptText }));
  return { text, lineMap: lineMapOf(text), diff: diffOf(base.text, text), scriptWrites };
}
