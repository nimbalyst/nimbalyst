import { buildTrackerCreatePayload, formatTrackerValidationErrors } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCreatePayload';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import type { SavedViewDefinition, TrackerDataSource } from '../../trackers';

export async function createViewItem(dataSource: TrackerDataSource, definition: SavedViewDefinition, title: string, groupFields: Record<string, unknown> = {}, requestId: string = crypto.randomUUID()): Promise<void> {
  const fields: Record<string, unknown> = {};
  for (const clause of definition.columnFilters?.clauses ?? []) {
    if (clause.op !== '=' && !(clause.op === 'in' && Array.isArray(clause.value) && clause.value.length === 1)) continue;
    const value = Array.isArray(clause.value) ? clause.value[0] : clause.value;
    const field = globalRegistry.get(definition.selectedType)?.fields.find(field => field.name === clause.field);
    if (!field || field.type === 'relationship' || field.multiValue) continue;
    fields[field.name] = field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === true || value === 'true' : value;
  }
  const itemId = `${definition.selectedType}_${requestId}`;
  const result = buildTrackerCreatePayload(definition.selectedType, { title, creationRequestId: itemId, fields: { ...fields, ...groupFields } }, {
    workspacePath: dataSource.status().workspacePath,
    generateId: () => itemId,
  });
  if (!result.ok) throw new Error(formatTrackerValidationErrors(result.errors));
  const outcome = await dataSource.command({ type: 'create-item', item: result.payload });
  const answer = outcome.result as { success?: boolean; error?: string } | undefined;
  if (answer?.success === false) throw new Error(answer.error || 'The item could not be created');
}
