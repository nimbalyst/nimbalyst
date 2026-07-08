interface CollabDocumentTypeRegistry {
  findMatchForFile(filePath: string): {
    key: string;
    registration: { collaboration?: { supported: boolean } };
  } | undefined;
}

/**
 * Derive the logical collab document type from a filename.
 *
 * Returns:
 * - the full registered custom-editor suffix without the leading dot
 *   (e.g. `mockup.html` for `.mockup.html`, `calc.md` for `.calc.md`)
 * - `markdown` for plain `.md` / `.markdown`
 * - `null` when the file is not eligible for collaborative share
 *
 * Precedence: a collaboration-enabled custom editor wins over the generic
 * markdown fallback. This matters for multi-suffix types that END in `.md`
 * (e.g. `.calc.md`): the registry's longest-suffix match resolves them to
 * their own editor, so they must NOT be shadowed by the `.md` -> markdown
 * shortcut. Plain `.md`/`.markdown` (no longer custom-editor suffix, or only
 * a non-collab one) still resolve to the built-in markdown type.
 */
export function deriveCollabDocumentType(
  fileName: string,
  registry: CollabDocumentTypeRegistry
): string | null {
  const lower = fileName.toLowerCase();

  const match = registry.findMatchForFile(lower);
  if (match?.registration.collaboration?.supported) {
    const key = match.key.startsWith('.') ? match.key.slice(1) : match.key;
    // `.md`/`.markdown` are the built-in markdown type regardless of any
    // registry entry keyed on them; every other matched suffix uses its own
    // custom-editor document type.
    if (key !== 'md' && key !== 'markdown') return key;
  }

  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  return null;
}
