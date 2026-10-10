/**
 * A page's links as the Links section reads them, and where the section gets
 * them. Each host supplies a `PageLinksSource`: the desktop reads its local
 * relationship index, the web console the server's.
 */
import { globalRegistry, relationInverseLabel } from '@nimbalyst/tracker-schema';
import { resolveRelationshipType, type TrackerPageLink } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerRelationships';

export type { TrackerPageLink };

export interface PageLinksSource {
  /**
   * Every link of the page, both directions. Null when they cannot be read
   * right now, which keeps whatever the section already shows.
   */
  linksFor(itemId: string): Promise<TrackerPageLink[] | null>;
}

export interface LinkedPage {
  itemId: string;
  title: string;
  typeId: string;
  sentences: string[];
}

export interface TrackerLinkGroup {
  label: string;
  pages: LinkedPage[];
}

const MENTIONS = 'Mentions';
const MENTIONED_IN = 'Mentioned in';

function linkLabel(link: TrackerPageLink, itemType: string | undefined): string {
  if (link.predicateId) {
    const predicate = globalRegistry.getPredicate(link.predicateId);
    if (!predicate) return link.predicateId;
    return link.direction === 'out' ? predicate.label : relationInverseLabel(predicate);
  }
  if (link.sourceFieldId.startsWith('body:')) return link.direction === 'out' ? MENTIONS : MENTIONED_IN;
  // A relationship field without a declared predicate: the indexed type key
  // carries a per-value override (a `depends-on` field holding a `blocks`
  // value), so it wins. The field's default type is only a fallback; the field
  // lives on the source item's type.
  let typeKey = link.relationshipTypeKey ?? null;
  if (!typeKey) {
    const sourceType = link.direction === 'out' ? itemType : link.otherTypeId;
    typeKey = globalRegistry.get(sourceType ?? '')?.fields.find((f) => f.name === link.sourceFieldId)?.relationshipTypeKey ?? null;
  }
  const rel = resolveRelationshipType(typeKey ?? undefined);
  if (rel) return link.direction === 'out' ? rel.displayName : (rel.inverseDisplayName ?? rel.displayName);
  // A workspace key with no registered type (`part-of`, `concerns`) has no
  // inverse name. Going out, the key reads as is. Coming in, the other item's
  // field name says what this page is to it: "parent" on a child means this
  // page is its parent.
  if (link.direction === 'out') return humanizeKey(typeKey ?? link.sourceFieldId);
  return `${humanizeKey(link.sourceFieldId)} of`;
}

/** `part-of` or `dependsOn` as a label: "Part of", "Depends on". */
function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Group links by the label they read under from this page; mentions sort last. */
export function groupTrackerPageLinks(links: TrackerPageLink[], itemType: string | undefined): TrackerLinkGroup[] {
  const groups = new Map<string, Map<string, LinkedPage>>();
  for (const link of links) {
    const label = linkLabel(link, itemType);
    let pages = groups.get(label);
    if (!pages) groups.set(label, (pages = new Map()));
    let page = pages.get(link.otherItemId);
    if (!page) {
      page = { itemId: link.otherItemId, title: link.otherTitle || link.otherIssueKey || link.otherItemId, typeId: link.otherTypeId, sentences: [] };
      pages.set(link.otherItemId, page);
    }
    if (link.sentence && !page.sentences.includes(link.sentence)) page.sentences.push(link.sentence);
  }
  const rank = (label: string) => (label === MENTIONS ? 1 : label === MENTIONED_IN ? 2 : 0);
  return Array.from(groups, ([label, pages]) => ({ label, pages: Array.from(pages.values()) }))
    .sort((a, b) => rank(a.label) - rank(b.label));
}
