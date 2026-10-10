/**
 * Title to file name, and the clash rule. See FORMAT.md "File names".
 */

const MAX_STEM_BYTES = 200;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function fileStemForTitle(title: string): string {
  let stem = title
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (Buffer.byteLength(stem, 'utf8') > MAX_STEM_BYTES) {
    while (Buffer.byteLength(stem, 'utf8') > MAX_STEM_BYTES) stem = Array.from(stem).slice(0, -1).join('');
    stem = stem.replace(/[. ]+$/, '');
  }
  if (stem === '') stem = 'Untitled';
  if (WINDOWS_RESERVED.test(stem)) stem += '_';
  return stem;
}

/** Comparison key for the clash rule: NFC, case-folded. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** `base`, else `base (2)`, `base (3)`, ... whichever key is free. */
export function uniqueStem(base: string, occupied: ReadonlySet<string>): string {
  if (!occupied.has(nameKey(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!occupied.has(nameKey(candidate))) return candidate;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The page title for a file: the frontmatter `title` when the file name is
 * still derived from it (exactly, or with a clash suffix), else the file name.
 * A file renamed outside Nimbalyst therefore takes its new name as its title.
 */
export function titleForStem(stem: string, frontmatterTitle: string | null): string {
  if (!frontmatterTitle) return stem;
  const expected = fileStemForTitle(frontmatterTitle);
  const key = nameKey(stem);
  if (key === nameKey(expected)) return frontmatterTitle;
  if (new RegExp(`^${escapeRegExp(nameKey(expected))} \\(\\d+\\)$`).test(key)) return frontmatterTitle;
  return stem;
}
