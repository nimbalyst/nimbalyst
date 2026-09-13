/**
 * One place that turns "the user filled in a form for tracker type X" into the
 * `documentService.createTrackerItem` payload.
 *
 * Before this existed, every renderer create surface re-derived its own id,
 * status default, and sharing flags, hardcoded `{title, status, priority}`, and
 * skipped schema validation entirely — `globalRegistry.validate()` only ran on
 * the MCP path. A schema that renamed `status` or marked a field required could
 * not be satisfied from the UI at all.
 *
 * Pure: no `window`, no IPC, no clock unless you let it default. `generateId`
 * and `now` are injectable so the result is assertable in tests.
 */

import {
  globalRegistry,
  type FieldDefinition,
  type TrackerDataModel,
  type TrackerDataModelRegistry,
  type TrackerSharing,
} from './TrackerDataModel';

export interface TrackerValidationIssue {
  field: string;
  message: string;
}

/** Mirrors `documentService.createTrackerItem`'s argument. */
export interface TrackerCreatePayload {
  id: string;
  type: string;
  title: string;
  status: string;
  priority: string;
  workspace: string;
  description?: string;
  content?: string;
  creationRequestId?: string;
  owner?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
  sharing: TrackerSharing;
  draftByDefault: boolean;
}

export interface TrackerCreateValues {
  title: string;
  description?: string;
  content?: string;
  creationRequestId?: string;
  /**
   * Field values keyed by their name **in this schema** — so a type whose
   * `workflowStatus` role points at `state` supplies `{ state: 'open' }`.
   */
  fields?: Record<string, unknown>;
}

export interface TrackerCreateContext {
  workspacePath: string;
  registry?: TrackerDataModelRegistry;
  generateId?: () => string;
}

export type TrackerCreatePayloadResult =
  | { ok: true; payload: TrackerCreatePayload; warnings: TrackerValidationIssue[] }
  | { ok: false; errors: TrackerValidationIssue[] };

/** The field names `createTrackerItem` already writes at the top level of `data`. */
const CANONICAL_FIELD_NAMES = {
  title: 'title',
  status: 'status',
  priority: 'priority',
  owner: 'owner',
  tags: 'tags',
} as const;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function defaultIdFor(model: TrackerDataModel | undefined, type: string): string {
  const prefix = model?.idPrefix || type.substring(0, 3);
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
}

function fieldDefault(fields: FieldDefinition[], name: string): unknown {
  return fields.find((field) => field.name === name)?.default;
}

export function buildTrackerCreatePayload(
  type: string,
  values: TrackerCreateValues,
  ctx: TrackerCreateContext,
): TrackerCreatePayloadResult {
  const registry = ctx.registry ?? globalRegistry;
  const model = registry.get(type);

  if (!model) {
    return { ok: false, errors: [{ field: 'type', message: `Unknown tracker type: ${type}` }] };
  }
  if (model.creatable === false) {
    return {
      ok: false,
      errors: [{ field: 'type', message: `Cannot create items of type '${type}': type is not creatable` }],
    };
  }

  const title = values.title.trim();
  if (!title) {
    return { ok: false, errors: [{ field: 'title', message: 'Title is required' }] };
  }

  const id = ctx.generateId?.() ?? defaultIdFor(model, type);
  const roles = model.roles ?? {};
  const titleField = roles.title ?? CANONICAL_FIELD_NAMES.title;
  const statusField = roles.workflowStatus ?? CANONICAL_FIELD_NAMES.status;
  const priorityField = roles.priority ?? CANONICAL_FIELD_NAMES.priority;
  const assigneeField = roles.assignee ?? CANONICAL_FIELD_NAMES.owner;
  const tagsField = roles.tags ?? CANONICAL_FIELD_NAMES.tags;

  // Flat, schema-named bag — the shape `globalRegistry.validate` expects and the
  // shape `createTrackerItem` reassembles from `customFields`.
  const data: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values.fields ?? {})) {
    if (!isEmpty(value)) data[name] = value;
  }
  data[titleField] = title;

  for (const field of model.fields) {
    if (data[field.name] === undefined && field.default !== undefined) {
      data[field.name] = field.default;
    }
  }

  // Self-identifier fields (plan.planId, decision.decisionId) are marked required
  // by their schema but have no UI. Seed them with the item id, matching the MCP
  // create path — without this those types cannot be created from a form at all.
  for (const field of model.fields) {
    if (field.required && field.type === 'string' && field.displayInline === false && data[field.name] === undefined) {
      data[field.name] = id;
    }
  }

  if (isEmpty(data[statusField])) {
    const schemaDefault = fieldDefault(model.fields, statusField);
    data[statusField] = typeof schemaDefault === 'string' ? schemaDefault : 'to-do';
  }
  if (isEmpty(data[priorityField])) {
    const schemaDefault = fieldDefault(model.fields, priorityField);
    data[priorityField] = typeof schemaDefault === 'string' ? schemaDefault : 'medium';
  }

  const validation = registry.validate(type, data);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  // Anything already carried by a top-level payload key would be written twice.
  // A *renamed* role field stays in customFields so the schema's own field name
  // gets a value too.
  const carriedTopLevel = new Set<string>([CANONICAL_FIELD_NAMES.title, 'description']);
  if (statusField === CANONICAL_FIELD_NAMES.status) carriedTopLevel.add(statusField);
  if (priorityField === CANONICAL_FIELD_NAMES.priority) carriedTopLevel.add(priorityField);
  if (assigneeField === CANONICAL_FIELD_NAMES.owner) carriedTopLevel.add(assigneeField);
  if (tagsField === CANONICAL_FIELD_NAMES.tags) carriedTopLevel.add(tagsField);

  const customFields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    if (carriedTopLevel.has(name)) continue;
    customFields[name] = value;
  }

  const ownerValue = data[assigneeField];
  const tagsValue = data[tagsField];
  const description = values.description?.trim();

  return {
    ok: true,
    warnings: validation.warnings ?? [],
    payload: {
      id,
      type,
      title,
      status: String(data[statusField]),
      priority: String(data[priorityField]),
      workspace: ctx.workspacePath,
      ...(description ? { description } : {}),
      ...(values.content !== undefined ? { content: values.content } : {}),
      ...(values.creationRequestId ? { creationRequestId: values.creationRequestId } : {}),
      ...(typeof ownerValue === 'string' && ownerValue ? { owner: ownerValue } : {}),
      ...(Array.isArray(tagsValue) && tagsValue.length > 0
        ? { tags: tagsValue.filter((tag): tag is string => typeof tag === 'string') }
        : {}),
      ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
      sharing: model.sharing ?? 'personal',
      draftByDefault: model.draftByDefault ?? false,
    },
  };
}

/** Flatten typed validation errors into one line for a form-level message. */
export function formatTrackerValidationErrors(errors: TrackerValidationIssue[]): string {
  return errors.map((error) => error.message).join('; ');
}
