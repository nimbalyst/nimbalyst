/**
 * Inline Python code-completion provider for Monaco.
 *
 * Surfaces:
 *   - Python language keywords (def, class, return, yield, ...)
 *   - Common standard-library identifiers (os, json, pathlib.Path, ...)
 *   - In-file identifiers collected by a lightweight, regex-based scanner:
 *       * names on the LHS of `=` assignments
 *       * `def name(` and `class Name` headers
 *       * parameters inside `def name(...):` and `class Name(...):` signatures
 *       * names imported via `import X` / `from X import a, b`
 *
 * No project-wide AST index is required for this PR. The core is a pure
 * function `providePythonCompletionsFromText(text, offset)` so unit tests
 * can run without a real Monaco model.
 */

import type { languages } from 'monaco-editor';

export type PythonCompletionItem = languages.CompletionItem;

const PYTHON_KEYWORDS: readonly string[] = [
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
];

/**
 * A small, opinionated set of stdlib identifiers people reach for often.
 * Curated rather than comprehensive; expanded lazily as the project asks.
 */
const PYTHON_STDLIB: readonly { label: string; detail: string }[] = [
  { label: 'os.path.join', detail: 'os.path.join' },
  { label: 'os.makedirs', detail: 'os.makedirs' },
  { label: 'os.getenv', detail: 'os.getenv' },
  { label: 'os.listdir', detail: 'os.listdir' },
  { label: 'json.dumps', detail: 'str' },
  { label: 'json.loads', detail: 'Any' },
  { label: 'pathlib.Path', detail: 'class' },
  { label: 're.match', detail: 're.Match' },
  { label: 're.search', detail: 're.Match' },
  { label: 're.compile', detail: 'Pattern' },
  { label: 're.sub', detail: 'str' },
  { label: 'subprocess.run', detail: 'CompletedProcess' },
  { label: 'subprocess.Popen', detail: 'Popen' },
  { label: 'sys.argv', detail: 'list[str]' },
  { label: 'sys.exit', detail: 'None' },
  { label: 'sys.path', detail: 'list[str]' },
  { label: 'collections.defaultdict', detail: 'class' },
  { label: 'collections.Counter', detail: 'class' },
  { label: 'dataclasses.dataclass', detail: 'class' },
  { label: 'typing.Any', detail: 'type' },
  { label: 'typing.List', detail: 'type' },
  { label: 'typing.Dict', detail: 'type' },
  { label: 'typing.Optional', detail: 'type' },
];

const ASYNC_DEF_RE = /\b(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const CLASS_RE = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(:]/g;
const PARAM_LIST_RE = /\(([^)]*)\)/g;
const IMPORT_NAME_RE = /\bimport\s+([A-Za-z_][A-Za-z0-9_.]*)/g;
const FROM_IMPORT_RE = /\bfrom\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([^\n]+)/g;
const ASSIGNMENT_LHS_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=[^=]/gm;

function getCurrentPrefix(text: string, offset: number): string {
  let i = offset;
  while (i > 0) {
    const ch = text[i - 1];
    if (!/[A-Za-z0-9_.]/.test(ch)) break;
    i--;
  }
  return text.slice(i, offset);
}

function parseParams(paramList: string): string[] {
  // Strip defaults and annotations, then split on top-level commas so
  // `a, b: int = 3, **kwargs` returns `['a', 'b', 'kwargs']`.
  const cleaned = paramList
    .replace(/#[^\n]*/g, '') // strip inline comments
    .replace(/\bself\b/g, '')
    .replace(/\bcls\b/g, '');
  const names: string[] = [];
  let depth = 0;
  let buf = '';
  const chunks: string[] = [];
  for (const ch of cleaned) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      chunks.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) chunks.push(buf);

  for (const chunk of chunks) {
    if (chunk.trim().startsWith('**')) {
      names.push(chunk.trim().slice(2));
      continue;
    }
    if (chunk.trim().startsWith('*')) {
      const m = chunk.trim().slice(1).match(/[A-Za-z_][A-Za-z0-9_]*/);
      if (m) names.push(m[0]);
      continue;
    }
    const m = chunk.match(/[A-Za-z_][A-Za-z0-9_]*/);
    if (m) names.push(m[0]);
  }
  return names.filter((name) => name.length > 0);
}

function collectInFileIdentifiers(text: string): string[] {
  const found = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = ASYNC_DEF_RE.exec(text)) !== null) {
    if (match[1]) found.add(match[1]);
  }
  while ((match = CLASS_RE.exec(text)) !== null) {
    if (match[1]) found.add(match[1]);
  }

  // Collect params per `def`/`class` line. We pair the param list with the
  // closest preceding comma-free header so multi-line signatures track
  // correctly without a real Python parser.
  const headerRE = /\b(?:async\s+)?(?:def|class)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/g;
  while ((match = headerRE.exec(text)) !== null) {
    const openOffset = match.index + match[0].length - 1;
    // Find matching close paren from openOffset.
    let depth = 1;
    let end = openOffset + 1;
    while (end < text.length && depth > 0) {
      const ch = text[end];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth > 0) end++;
    }
    if (depth !== 0) continue; // unbalanced, skip
    const params = parseParams(text.slice(openOffset + 1, end));
    for (const name of params) {
      if (name) found.add(name);
    }
  }

  while ((match = IMPORT_NAME_RE.exec(text)) !== null) {
    if (match[1]) {
      const moduleName = match[1].split('.')[0];
      if (moduleName) found.add(moduleName);
    }
  }
  while ((match = FROM_IMPORT_RE.exec(text)) !== null) {
    const module = match[1];
    const names = (match[2] ?? '').split(',');
    if (module) {
      const moduleName = module.split('.')[0];
      if (moduleName) found.add(moduleName);
    }
    for (const raw of names) {
      const asMatch = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/);
      if (asMatch && asMatch[2]) {
        found.add(asMatch[2]);
      } else if (asMatch && asMatch[1]) {
        found.add(asMatch[1]);
      }
    }
  }
  while ((match = ASSIGNMENT_LHS_RE.exec(text)) !== null) {
    if (match[1]) found.add(match[1]);
  }

  return [...found];
}

export function providePythonCompletionsFromText(
  text: string,
  offset: number,
  options: { extraInFileIdentifiers?: readonly string[] } = {},
): PythonCompletionItem[] {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const prefix = getCurrentPrefix(text, safeOffset);
  const prefixLower = prefix.toLowerCase();

  const seen = new Set<string>();
  const items: PythonCompletionItem[] = [];

  // 1) In-file identifiers (highest priority — most contextually relevant).
  const inFile = collectInFileIdentifiers(text);
  for (const extra of [inFile, options.extraInFileIdentifiers ?? []]) {
    for (const name of extra) {
      if (!name || seen.has(name)) continue;
      if (prefixLower && !name.toLowerCase().startsWith(prefixLower)) continue;
      seen.add(name);
      items.push({
        label: name,
        kind: 6 /* Variable */ as PythonCompletionItem['kind'],
        insertText: name,
        detail: 'identifier',
      });
    }
  }

  // 2) Stdlib names.
  for (const entry of PYTHON_STDLIB) {
    if (seen.has(entry.label)) continue;
    const lower = entry.label.toLowerCase();
    if (prefixLower && !lower.startsWith(prefixLower)) continue;
    seen.add(entry.label);
    items.push({
      label: entry.label,
      kind: 9 /* Class */ as PythonCompletionItem['kind'],
      insertText: entry.label,
      detail: entry.detail,
    });
  }

  // 3) Keywords.
  for (const kw of PYTHON_KEYWORDS) {
    if (seen.has(kw)) continue;
    if (prefixLower && !kw.toLowerCase().startsWith(prefixLower)) continue;
    seen.add(kw);
    items.push({
      label: kw,
      kind: 14 /* Keyword */ as PythonCompletionItem['kind'],
      insertText: kw,
      detail: 'keyword',
    });
  }
  return items;
}

/**
 * Adapter for `monaco.languages.registerCompletionItemProvider('python', { provideCompletionItems })`.
 */
export function providePythonCompletions(
  model: { getValue: () => string; getOffsetAt: (pos: { lineNumber: number; column: number }) => number },
  position: { lineNumber: number; column: number },
  options: { extraInFileIdentifiers?: readonly string[] } = {},
): PythonCompletionItem[] {
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  return providePythonCompletionsFromText(text, offset, options);
}
