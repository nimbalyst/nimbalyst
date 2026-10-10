/**
 * Decision and open-question marks in the Local wiki's page files, for the
 * cross-page marks list. Bodies are read through the library on each query;
 * a page with no mark syntax in it is skipped before parsing.
 */
import type { LocalWiki } from '@nimbalyst/local-wiki';
import type { PageMarkRecord } from '@nimbalyst/collab-client/pages';
import { marksIn } from '../pageMarks/pageMarksQuery';
import { isTypePageProse } from './personalPagesExport';

export async function localWikiPageMarks(wiki: LocalWiki | null): Promise<PageMarkRecord[]> {
  if (!wiki) return [];
  const out: PageMarkRecord[] = [];
  for (const page of (await wiki.snapshot()).pages) {
    // A stray type description file is not a page (see LocalWikiService); its description is in the app.
    if (page.trashedAt !== null || page.malformed || !page.hasContent || isTypePageProse(page.id)) continue;
    const { markdown } = await wiki.readBody(page.id);
    if (!markdown.includes(']{decided') && !markdown.includes(']{open')) continue;
    out.push(...marksIn(markdown, {
      kind: page.type ? 'typed-page' : 'personal-page',
      scope: 'personal',
      id: page.id,
      title: page.title,
      // The same uris the Local section opens: a typed page as its item, a page by id.
      uri: page.type ? `tracker://${page.id}` : `personal://${page.id}`,
      typeId: page.type ?? null,
      issueKey: null,
    }));
  }
  return out;
}
