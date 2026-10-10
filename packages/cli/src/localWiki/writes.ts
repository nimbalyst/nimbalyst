/**
 * Write-side helpers shared by `nim wiki` and `nim mcp`.
 */
import type { LocalWiki } from '@nimbalyst/local-wiki';
import { usageError } from '../cli/exitCodes.js';
import { livePages } from './tree.js';

/**
 * The page at `folderPath` ('A/B', by titles from the top of the wiki), creating
 * any missing page on the way as an empty page. Returns its id, or null for ''.
 */
export async function ensureFolderPath(wiki: LocalWiki, folderPath: string): Promise<string | null> {
  let parentId: string | null = null;
  for (const title of folderPath.split('/').map((part) => part.trim()).filter(Boolean)) {
    const snapshot = await wiki.snapshot();
    const existing = livePages(snapshot).find(
      (page) => (page.parentId ?? null) === parentId && page.title.toLowerCase() === title.toLowerCase(),
    );
    parentId = existing
      ? existing.id
      : (await wiki.command({ type: 'register-document', title, parentFolderId: parentId })).id ?? null;
  }
  return parentId;
}

export interface Replacement {
  oldText: string;
  newText: string;
}

/** Apply exact replacements in order, each to its first match. Any miss fails the whole edit. */
export function applyReplacements(markdown: string, replacements: Replacement[]): string {
  let out = markdown;
  replacements.forEach((r, i) => {
    if (typeof r?.oldText !== 'string' || typeof r?.newText !== 'string') {
      throw usageError(`replacements[${i}] needs oldText and newText strings`);
    }
    if (r.oldText === '') throw usageError(`replacements[${i}].oldText is empty`);
    const at = out.indexOf(r.oldText);
    if (at < 0) throw usageError(`replacements[${i}].oldText was not found in the page; read it again and copy the text exactly`);
    out = out.slice(0, at) + r.newText + out.slice(at + r.oldText.length);
  });
  return out;
}
