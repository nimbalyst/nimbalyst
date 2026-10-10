/**
 * A typed page's relationship-field links, both directions, read straight from
 * the tracker records a browser holds: the field half of the desktop's local
 * relationship index (`trackerPageLinks.ts`), in the same row shape, so the
 * Links section groups them the same way. Body links come from elsewhere (the
 * server's page links index on the web).
 */
import { globalRegistry, type FieldDefinition } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { deriveRelationshipEdges } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerRelationships';
import type { TrackerPageLink } from './pageLinks';
import { readStoredFieldValue } from '../../trackers/relationshipFieldStorage';

type FieldDefs = (typeId: string) => ReadonlyArray<Pick<FieldDefinition, 'name' | 'type'>>;

function edgesOf(record: TrackerRecord, fieldDefs: FieldDefs) {
  const defs = fieldDefs(record.primaryType) as FieldDefinition[];
  const fields: Record<string, unknown> = {};
  for (const def of defs) fields[def.name] = readStoredFieldValue(record.fields, def.name);
  return deriveRelationshipEdges(record.id, fields, defs);
}

export function fieldRelationLinks(
  itemId: string,
  records: Iterable<TrackerRecord>,
  fieldDefs: FieldDefs = (typeId) => globalRegistry.get(typeId)?.fields ?? [],
): TrackerPageLink[] {
  const byId = new Map<string, TrackerRecord>();
  for (const record of records) byId.set(record.id, record);
  const link = (direction: 'out' | 'in', other: TrackerRecord, edge: ReturnType<typeof edgesOf>[number]): TrackerPageLink => ({
    direction,
    predicateId: edge.predicate ?? null,
    relationshipTypeKey: edge.relationshipTypeKey ?? null,
    otherItemId: other.id,
    otherTitle: getRecordTitle(other).trim(),
    otherIssueKey: other.issueKey ?? null,
    otherTypeId: other.primaryType,
    sentence: null,
    sourceFieldId: edge.sourceFieldId,
  });

  const links: TrackerPageLink[] = [];
  const self = byId.get(itemId);
  if (self) {
    for (const edge of edgesOf(self, fieldDefs)) {
      const other = byId.get(edge.targetItemId);
      if (other && other.id !== itemId) links.push(link('out', other, edge));
    }
  }
  for (const record of byId.values()) {
    if (record.id === itemId) continue;
    for (const edge of edgesOf(record, fieldDefs)) {
      if (edge.targetItemId === itemId) links.push(link('in', record, edge));
    }
  }
  return links;
}
