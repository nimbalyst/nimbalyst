/**
 * Heading-aware markdown chunker.
 *
 * Splits a markdown document into ~minTokens..maxTokens chunks that never cross
 * a heading boundary, each carrying its full heading breadcrumb (`headingPath`)
 * so a hit can later expand to its whole section. Frontmatter is stripped and
 * fenced code blocks are treated atomically (their `#` lines are not headings,
 * and they are never split mid-fence).
 */
import { sha256 } from './hash.js';
import type { Chunk } from './types.js';

const CHARS_PER_TOKEN = 4;
const DEFAULT_MIN_TOKENS = 200;
const DEFAULT_MAX_TOKENS = 500;

/** Rough token estimate (no tokenizer dependency): ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ChunkOptions {
  minTokens?: number;
  maxTokens?: number;
}

interface Section {
  headingPath: string[];
  /** Body lines including the heading line itself (if any). */
  lines: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```+|~~~+)/;

/** Strip a leading YAML frontmatter block (`--- ... ---`). */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n');
    }
  }
  return text;
}

/** Break a document into sections keyed by heading breadcrumb. */
function toSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { headingPath: [], lines: [] };
  let inFence = false;

  const pushCurrent = () => {
    if (current.lines.some((l) => l.trim().length > 0)) sections.push(current);
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      current.lines.push(line);
      continue;
    }
    const m = !inFence ? HEADING_RE.exec(line) : null;
    if (m) {
      pushCurrent();
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      current = { headingPath: stack.map((s) => s.title), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  pushCurrent();
  return sections;
}

/** Split section body into blocks (paragraphs + atomic fenced code blocks). */
function toBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) blocks.push(text);
    buf = [];
  };
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

/** Hard-split an oversized single block on word boundaries. */
function splitOversized(block: string, maxTokens: number): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (block.length <= maxChars) return [block];
  const words = block.split(/(\s+)/);
  const out: string[] = [];
  let buf = '';
  for (const w of words) {
    if (buf.length + w.length > maxChars && buf.trim()) {
      out.push(buf.trim());
      buf = '';
    }
    buf += w;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Chunk a markdown document. Returns chunks in document order with stable
 * per-file ordinals. `sourcePath`/`sourceClass` are attached verbatim.
 */
export function chunkMarkdown(
  sourcePath: string,
  sourceClass: string,
  raw: string,
  opts: ChunkOptions = {},
  ref?: { refType?: string; refId?: string }
): Chunk[] {
  const refType = ref?.refType ?? 'doc-file';
  const refId = ref?.refId ?? sourcePath;
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const body = stripFrontmatter(raw);
  const sections = toSections(body);

  const texts: { headingPath: string[]; text: string }[] = [];
  for (const section of sections) {
    const rawBlocks = toBlocks(section.lines);
    const blocks = rawBlocks.flatMap((b) => splitOversized(b, maxTokens));
    let buf: string[] = [];
    let bufTokens = 0;
    const flush = () => {
      const text = buf.join('\n\n').trim();
      if (text) texts.push({ headingPath: section.headingPath, text });
      buf = [];
      bufTokens = 0;
    };
    for (const block of blocks) {
      const t = estimateTokens(block);
      if (bufTokens > 0 && bufTokens + t > maxTokens) flush();
      buf.push(block);
      bufTokens += t;
      // Once we comfortably exceed the minimum, close the chunk so sections
      // pack into even ~min..max slices rather than one big tail chunk.
      if (bufTokens >= minTokens) flush();
    }
    flush();
  }

  return texts.map((c, ordinal) => ({
    id: `${sourcePath}#${ordinal}`,
    sourcePath,
    sourceClass,
    headingPath: c.headingPath,
    text: c.text,
    contentHash: sha256(c.text),
    ordinal,
    refType,
    refId,
  }));
}
