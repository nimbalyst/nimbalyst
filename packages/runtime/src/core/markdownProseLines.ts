/**
 * Line scanning helpers for pure markdown readers (marks, citations) that must
 * skip what the editor would not parse as prose: frontmatter, fenced code
 * blocks and inline code spans. React-, DOM- and Lexical-free.
 */

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Calls `visit` for every line outside frontmatter and fenced code blocks, with
 * the offset of the line's first character in `markdown` and its 0-based index.
 */
export function forEachProseLine(
  markdown: string,
  visit: (line: string, lineStart: number, index: number) => void,
): void {
  const lines = markdown.split('\n');
  let offset = 0;
  let fence: string | null = null;
  let inFrontmatter = lines[0]?.trim() === '---';
  lines.forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;
    if (inFrontmatter) {
      if (index > 0 && line.trim() === '---') inFrontmatter = false;
      return;
    }
    const fenceMatch = FENCE_OPEN.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
        fence = null;
      }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return;
    }
    visit(line, lineStart, index);
  });
}

/** End offset (exclusive) of the backtick code span opening at `from`, or -1 when it never closes. */
export function codeSpanEnd(text: string, from: number): number {
  let ticks = 0;
  while (text[from + ticks] === '`') ticks++;
  const fence = '`'.repeat(ticks);
  let search = from + ticks;
  while (search < text.length) {
    const found = text.indexOf(fence, search);
    if (found === -1) return -1;
    let run = 0;
    while (text[found + run] === '`') run++;
    if (run === ticks) return found + ticks;
    search = found + run;
  }
  return -1;
}

/** `text` with every closed inline code span (backticks included) replaced by spaces, so offsets are kept. */
export function maskInlineCode(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      out += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (text[i] === '`') {
      const end = codeSpanEnd(text, i);
      if (end !== -1) {
        out += ' '.repeat(end - i);
        i = end - 1;
        continue;
      }
      let run = 0;
      while (text[i + run] === '`') run++;
      out += text.slice(i, i + run);
      i += run - 1;
      continue;
    }
    out += text[i];
  }
  return out;
}
