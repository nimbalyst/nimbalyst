/**
 * GitHub-style heading slug generation for in-document anchor navigation.
 *
 * Rules match GitHub's algorithm:
 * 1. Lowercase the text
 * 2. Remove anything that is not a letter, number, space, or hyphen
 * 3. Replace spaces (and runs of spaces) with a single hyphen
 * 4. Collapse consecutive hyphens
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
}
