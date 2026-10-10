/**
 * Inline Markdown snippet provider for Monaco.
 *
 * Surfaces snippets for:
 *   - ATX heading levels (# ## ### ####)
 *   - Inline & reference link syntax
 *   - Fenced code blocks (with optional language tag)
 *
 * Snippets use Monaco's `${1:placeholder}` tab-stop syntax so blocks
 * expand to the right shape with the cursor parked on the first slot.
 */

import type { languages } from 'monaco-editor';

export type MarkdownCompletionItem = languages.CompletionItem;

interface MarkdownSnippet {
  label: string;
  detail: string;
  insertText: string;
}

const MARKDOWN_SNIPPETS: readonly MarkdownSnippet[] = [
  {
    label: '# Heading 1',
    detail: 'Heading 1',
    insertText: '# ${1:Heading}',
  },
  {
    label: '## Heading 2',
    detail: 'Heading 2',
    insertText: '## ${1:Heading}',
  },
  {
    label: '### Heading 3',
    detail: 'Heading 3',
    insertText: '### ${1:Heading}',
  },
  {
    label: '#### Heading 4',
    detail: 'Heading 4',
    insertText: '#### ${1:Heading}',
  },
  {
    label: '# Heading 1 (multi)',
    detail: 'Heading 1',
    insertText: '# ${1:Heading}\n\n${2:Body}',
  },
  {
    label: '## Heading 2 (multi)',
    detail: 'Heading 2',
    insertText: '## ${1:Heading}\n\n${2:Body}',
  },
  {
    label: 'link',
    detail: 'Link',
    insertText: '[${1:text}](${2:url})',
  },
  {
    label: 'reference link',
    detail: 'Reference link',
    insertText: '[${1:text}][${2:ref}]\n\n[${2:ref}]: ${3:url}',
  },
  {
    label: 'image',
    detail: 'Image',
    insertText: '![${1:alt}](${2:url})',
  },
  {
    label: '```code```',
    detail: 'Fenced code',
    insertText: '```${1:lang}\n${2:code}\n```',
  },
  {
    label: '```python```',
    detail: 'Fenced code (python)',
    insertText: '```python\n${1:code}\n```',
  },
  {
    label: '```typescript```',
    detail: 'Fenced code (typescript)',
    insertText: '```typescript\n${1:code}\n```',
  },
  {
    label: '```bash```',
    detail: 'Fenced code (bash)',
    insertText: '```bash\n${1:code}\n```',
  },
  {
    label: '```json```',
    detail: 'Fenced code (json)',
    insertText: '```json\n${1:code}\n```',
  },
];

function getCurrentPrefix(text: string, offset: number): string {
  let i = offset;
  while (i > 0) {
    const ch = text[i - 1];
    if (!/[A-Za-z0-9_`#]/i.test(ch)) break;
    i--;
  }
  return text.slice(i, offset);
}

/**
 * Pure-function core. Returns the list of snippet items whose label
 * starts with the current word-prefix.
 */
export function provideMarkdownCompletionsFromText(
  text: string,
  offset: number,
): MarkdownCompletionItem[] {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const prefix = getCurrentPrefix(text, safeOffset);
  const prefixLower = prefix.toLowerCase();

  const items: MarkdownCompletionItem[] = [];
  for (const snippet of MARKDOWN_SNIPPETS) {
    if (prefixLower && !snippet.label.toLowerCase().startsWith(prefixLower)) {
      // Also accept the snippet when the prefix is `#` or `##` to keep
      // heading shortcuts ergonomic regardless of cursor column.
      if (!prefixLower.startsWith('#')) continue;
    }
    items.push({
      label: snippet.label,
      insertText: snippet.insertText,
      insertTextRules: 4 /* InsertAsSnippet */ as MarkdownCompletionItem['insertTextRules'],
      kind: 2 /* Snippet */ as MarkdownCompletionItem['kind'],
      detail: snippet.detail,
      documentation: snippet.insertText,
    });
  }
  return items;
}

/**
 * Adapter for `monaco.languages.registerCompletionItemProvider('markdown', { provideCompletionItems })`.
 */
export function provideMarkdownCompletions(
  model: { getValue: () => string; getOffsetAt: (pos: { lineNumber: number; column: number }) => number },
  position: { lineNumber: number; column: number },
): MarkdownCompletionItem[] {
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  return provideMarkdownCompletionsFromText(text, offset);
}
