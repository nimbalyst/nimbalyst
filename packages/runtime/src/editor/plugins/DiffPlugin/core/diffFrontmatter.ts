import { LexicalEditor } from "lexical";
import { ReplacementLike, resolveReplacementTexts } from "../../DiffPlugin/core/diffUtils";
import { $setFrontmatter, FrontmatterData, parseFrontmatter } from "../../../markdown/FrontmatterUtils";

// `\r?\n` tolerates Windows CRLF (nimbalyst#68).
const FRONTMATTER_BLOCK_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function extractFrontmatterBlock(markdown: string): { block: string; start: number; end: number } | null {
  const match = markdown.match(FRONTMATTER_BLOCK_REGEX);
  if (!match) {
    return null;
  }

  const start = match.index ?? 0;
  const block = match[0];
  const end = start + block.length;
  return {block, start, end};
}

function normalizeFrontmatterBlock(block: string, trailingNewlines: string): string {
  let normalized = block.trim();

  if (!normalized.startsWith('---')) {
    normalized = `---\n${normalized}`;
  }

  if (!/\n---$/.test(normalized)) {
    normalized = normalized.replace(/\s*$/, '');
    if (!normalized.endsWith('---')) {
      normalized = `${normalized}\n---`;
    }
  }

  normalized = normalized.replace(/\s*$/, '');

  if (!trailingNewlines) {
    trailingNewlines = '\n\n';
  }

  if (!trailingNewlines.endsWith('\n')) {
    trailingNewlines += '\n';
  }

  return `${normalized}${trailingNewlines}`;
}

function tryApplyFrontmatterFallback(
  originalMarkdown: string,
  replacements: ReplacementLike[],
): string | null {
  const originalFrontmatter = extractFrontmatterBlock(originalMarkdown);

  for (const replacement of replacements) {
    let newText: string;
    try {
      ({newText} = resolveReplacementTexts(replacement));
    } catch {
      continue;
    }

    const newFrontmatter = extractFrontmatterBlock(newText);
    if (!newFrontmatter) {
      continue;
    }

    const trailingNewlines = originalFrontmatter
      ? originalFrontmatter.block.match(/\n*$/)?.[0] ?? '\n'
      : '\n\n';

    const normalizedBlock = normalizeFrontmatterBlock(newFrontmatter.block, trailingNewlines);

    if (originalFrontmatter) {
      const before = originalMarkdown.slice(0, originalFrontmatter.start);
      const after = originalMarkdown.slice(originalFrontmatter.end);
      const candidate = `${before}${normalizedBlock}${after}`;
      if (candidate !== originalMarkdown) {
        return candidate;
      }
    } else {
      const body = originalMarkdown.replace(/^\s*/, '');
      const prefix = normalizedBlock.endsWith('\n') ? normalizedBlock : `${normalizedBlock}\n`;
      const separator = body.length === 0 || body.startsWith('\n') ? '' : '\n';
      return `${prefix}${separator}${body}`;
    }
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) {
        return false;
      }
      if (!deepEqual(a[keysA[i]], b[keysB[i]])) {
        return false;
      }
    }
    return true;
  }

  if ((a === undefined || a === null) && (b === undefined || b === null)) {
    return true;
  }

  return false;
}

export function applyFrontmatterUpdateIfNeeded(
  editor: LexicalEditor,
  originalMarkdown: string,
  newMarkdown: string,
): {frontmatterUpdated: boolean; bodyChanged: boolean} {
  const originalParsed = parseFrontmatter(originalMarkdown);
  const newParsed = parseFrontmatter(newMarkdown);

  const originalData = originalParsed.data ?? null;
  const newData = newParsed.data ?? null;

  const frontmatterChanged = !deepEqual(originalData, newData);
  const bodyChanged = originalParsed.content !== newParsed.content;

  if (frontmatterChanged) {
    editor.update(() => {
      $setFrontmatter(newData as FrontmatterData | null);
    }, { discrete: true });
  }

  return {
    frontmatterUpdated: frontmatterChanged,
    bodyChanged,
  };
}
