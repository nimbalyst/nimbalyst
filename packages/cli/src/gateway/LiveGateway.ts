/**
 * Live mode: drive a running Nimbalyst over its loopback MCP-HTTP server so
 * reads reflect in-app state (and, in phase 2, writes flow through the
 * WriteCoordinator + collab sync).
 *
 * MCP tracker tools return the legacy TrackerItem DTO; we adapt it to the
 * canonical TrackerRecord so the output layer is identical across modes.
 */
import { McpHttpClient } from './mcpClient.js';
import type { EndpointDescriptor } from './endpoint.js';
import type { TrackerRecord } from '../vendor/trackerRecord.js';
import { connectionError } from '../cli/exitCodes.js';
import type {
  CreateInput,
  GatewayStatus,
  ImporterInfo,
  ImporterSearchOptions,
  ImporterSearchResult,
  ImportOptions,
  ImportResult,
  ListFilters,
  ResnapshotResult,
  TrackerGateway,
  TrackerTypeSummary,
  UpdateInput,
} from './types.js';

export class LiveGateway implements TrackerGateway {
  readonly mode = 'live' as const;
  private client: McpHttpClient;
  private descriptor: EndpointDescriptor;

  constructor(descriptor: EndpointDescriptor) {
    this.descriptor = descriptor;
    this.client = new McpHttpClient({ port: descriptor.port, token: descriptor.token });
  }

  async status(): Promise<GatewayStatus> {
    return {
      mode: this.mode,
      schemaVersion: this.descriptor.schemaVersion ?? null,
      endpoint: { pid: this.descriptor.pid, port: this.descriptor.port, startedAt: this.descriptor.startedAt },
      workspaces: this.descriptor.workspaces,
    };
  }

  async listWorkspaces(): Promise<{ path: string; name?: string }[]> {
    return this.descriptor.workspaces ?? [];
  }

  async listTrackers(filters: ListFilters): Promise<TrackerRecord[]> {
    const args: Record<string, unknown> = {};
    if (filters.type) args.type = filters.type;
    if (filters.typeTag) args.typeTag = filters.typeTag;
    if (filters.status && filters.status !== 'open' && filters.status !== 'closed') args.status = filters.status;
    if (filters.priority) args.priority = filters.priority;
    if (filters.owner) args.owner = filters.owner;
    if (filters.search) args.search = filters.search;
    if (filters.includeArchived) args.archived = true;
    if (filters.limit && filters.limit > 0) args.limit = filters.limit;
    if (filters.where?.length) {
      args.where = filters.where.map((w) => ({
        field: w.field,
        op: w.op === '~' ? 'contains' : w.op,
        value: w.op === 'in' ? w.value.split(',').map((s) => s.trim()) : w.value,
      }));
    }

    const result = await this.client.callTool(filters.workspace, 'tracker_list', args);
    const items: any[] = result.structured?.items ?? [];
    let records = items.map(mcpItemToRecord);

    // The MCP tool doesn't honor since/until or the open/closed meta-status, so
    // apply those client-side for parity with direct mode.
    records = applyClientSideFilters(records, filters);
    return records;
  }

  async getTracker(workspace: string, reference: string): Promise<TrackerRecord | null> {
    const result = await this.client.callTool(workspace, 'tracker_get', { id: reference });
    const item = result.structured?.item;
    return item ? mcpItemToRecord(item) : null;
  }

  async getTrackerByUrn(workspace: string, urn: string): Promise<TrackerRecord | null> {
    const result = await this.client.callTool(workspace, 'tracker_get_by_urn', { urn });
    if (result.structured?.found === false) return null;
    const item = result.structured?.item ?? result.structured;
    return item && item.id ? mcpItemToRecord(item) : null;
  }

  async getTrackerBody(workspace: string, record: TrackerRecord): Promise<string | undefined> {
    // tracker_get returns the markdown body in its summary / structured payload.
    const result = await this.client.callTool(workspace, 'tracker_get', { id: record.issueKey ?? record.id });
    const body = result.structured?.body ?? result.structured?.item?.body;
    if (typeof body === 'string') return body;
    return result.summary;
  }

  async listTypes(workspace: string): Promise<TrackerTypeSummary[]> {
    const result = await this.client.callTool(workspace, 'tracker_list_types', {});
    const types: any[] = result.structured?.types ?? result.structured?.items ?? [];
    return types.map((t) => ({
      type: t.type ?? t.name,
      displayName: t.displayName,
      builtin: t.builtin,
      defaultColumns: t.tableView?.defaultColumns,
    }));
  }

  // ---- writes --------------------------------------------------------------

  async createTracker(workspace: string, input: CreateInput): Promise<TrackerRecord> {
    const args: Record<string, unknown> = { type: input.type, title: input.title };
    if (input.description !== undefined) args.description = input.description;
    if (input.status !== undefined) args.status = input.status;
    if (input.priority !== undefined) args.priority = input.priority;
    if (input.owner !== undefined) args.owner = input.owner;
    if (input.dueDate !== undefined) args.dueDate = input.dueDate;
    if (input.progress !== undefined) args.progress = input.progress;
    if (input.tags?.length) args.tags = input.tags;
    if (input.labels?.length) args.labels = input.labels;
    if (input.typeTags?.length) args.typeTags = input.typeTags;
    if (input.linkedCommitSha !== undefined) args.linkedCommitSha = input.linkedCommitSha;
    if (input.fields && Object.keys(input.fields).length) args.fields = input.fields;
    if (input.linkSession) args.linkSession = true;

    const result = await this.client.callTool(workspace, 'tracker_create', args);
    const item = result.structured?.item;
    return item ? mcpItemToRecord(item) : emptyRecordFromInput(workspace, input);
  }

  async updateTracker(workspace: string, reference: string, input: UpdateInput): Promise<TrackerRecord> {
    const args: Record<string, unknown> = { id: reference };
    if (input.title !== undefined) args.title = input.title;
    if (input.status !== undefined) args.status = input.status;
    if (input.priority !== undefined) args.priority = input.priority;
    if (input.description !== undefined) args.description = input.description;
    if (input.owner !== undefined) args.owner = input.owner;
    if (input.dueDate !== undefined) args.dueDate = input.dueDate;
    if (input.progress !== undefined) args.progress = input.progress;
    if (input.tags) args.tags = input.tags;
    if (input.labels) args.labels = input.labels;
    if (input.typeTags) args.typeTags = input.typeTags;
    if (input.primaryType !== undefined) args.primaryType = input.primaryType;
    if (input.archived !== undefined) args.archived = input.archived;
    if (input.linkedCommitSha !== undefined) args.linkedCommitSha = input.linkedCommitSha;
    if (input.fields && Object.keys(input.fields).length) args.fields = input.fields;
    if (input.unsetFields?.length) args.unsetFields = input.unsetFields;

    const result = await this.client.callTool(workspace, 'tracker_update', args);
    const item = result.structured?.item;
    if (!item) {
      const fetched = await this.getTracker(workspace, reference);
      if (fetched) return fetched;
      throw connectionError(`Update of '${reference}' returned no item.`);
    }
    return mcpItemToRecord(item);
  }

  async commentTracker(workspace: string, reference: string, body: string): Promise<void> {
    await this.client.callTool(workspace, 'tracker_add_comment', { trackerId: reference, body });
  }

  async setArchived(workspace: string, reference: string, archived: boolean): Promise<TrackerRecord> {
    return this.updateTracker(workspace, reference, { archived });
  }

  async linkSession(workspace: string, reference: string, sessionId?: string): Promise<void> {
    const args: Record<string, unknown> = { trackerId: reference };
    if (sessionId) args.sessionId = sessionId;
    await this.client.callTool(workspace, 'tracker_link_session', args);
  }

  async defineType(workspace: string, schema: Record<string, unknown>, fileName?: string): Promise<void> {
    const args: Record<string, unknown> = { schema };
    if (fileName) args.fileName = fileName;
    const result = await this.client.callTool(workspace, 'tracker_define_type', args);
    if (result.isError) throw connectionError(result.summary ?? 'Failed to define tracker type.');
  }

  async deleteType(workspace: string, type: string): Promise<void> {
    const result = await this.client.callTool(workspace, 'tracker_delete_type', { type });
    if (result.isError) throw connectionError(result.summary ?? 'Failed to delete tracker type.');
  }

  // ---- importers -----------------------------------------------------------

  async importerList(workspace: string): Promise<ImporterInfo[]> {
    const result = await this.client.callTool(workspace, 'tracker_importer_list', {});
    if (result.isError) throw connectionError(result.summary ?? 'Failed to list importers.');
    const importers: any[] = result.structured?.importers ?? [];
    return importers.map((i) => ({
      id: i.id,
      displayName: i.displayName ?? i.id,
      urnScheme: i.urnScheme ?? '',
      importsAs: i.importsAs,
      icon: i.icon,
    }));
  }

  async importerSearch(workspace: string, opts: ImporterSearchOptions): Promise<ImporterSearchResult> {
    const args: Record<string, unknown> = { providerId: opts.providerId };
    if (opts.bindingId) args.bindingId = opts.bindingId;
    if (opts.search) args.search = opts.search;
    if (opts.state) args.state = opts.state;
    if (opts.limit !== undefined) args.limit = opts.limit;
    const result = await this.client.callTool(workspace, 'tracker_importer_search', args);
    if (result.isError) throw connectionError(result.summary ?? 'Importer search failed.');
    const s = result.structured ?? {};
    return { binding: s.binding, items: Array.isArray(s.items) ? s.items : [], nextCursor: s.nextCursor };
  }

  async importItem(workspace: string, opts: ImportOptions): Promise<ImportResult> {
    const args: Record<string, unknown> = { providerId: opts.providerId, externalId: opts.externalId };
    if (opts.primaryType) args.primaryType = opts.primaryType;
    const result = await this.client.callTool(workspace, 'tracker_import', args);
    if (result.isError) throw connectionError(result.summary ?? 'Import failed.');
    const s = result.structured ?? {};
    return { id: s.id, urn: s.urn, created: s.created ?? false, summary: s.summary ?? result.summary };
  }

  async resnapshot(workspace: string, urn: string): Promise<ResnapshotResult> {
    const result = await this.client.callTool(workspace, 'tracker_resnapshot', { urn });
    if (result.isError) throw connectionError(result.summary ?? 'Re-snapshot failed.');
    const s = result.structured ?? {};
    return {
      id: s.id,
      urn: s.urn ?? urn,
      titleUpdated: s.titleUpdated,
      statusUpdated: s.statusUpdated,
      bodyChanged: s.bodyChanged,
      summary: s.summary ?? result.summary,
    };
  }

  close(): void {
    /* stateless HTTP; nothing to close */
  }
}

/** Fallback record if the create tool omitted the item (still report success). */
function emptyRecordFromInput(workspace: string, input: CreateInput): TrackerRecord {
  return {
    id: '(created)',
    primaryType: input.type,
    typeTags: [input.type, ...(input.typeTags ?? [])],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    fields: { title: input.title, status: input.status, priority: input.priority },
  };
}

function applyClientSideFilters(records: TrackerRecord[], filters: ListFilters): TrackerRecord[] {
  let out = records;
  const dateField = filters.dateField === 'created' ? 'createdAt' : 'updatedAt';
  if (filters.since) out = out.filter((r) => (r.system[dateField] ?? '') >= filters.since!);
  if (filters.until) out = out.filter((r) => (r.system[dateField] ?? '') <= filters.until!);
  if (filters.status === 'open' || filters.status === 'closed') {
    // mirror DirectGateway terminal semantics
    out = out.filter((r) => {
      const s = String(r.fields.status ?? '').toLowerCase();
      const terminal = ['done', 'closed', 'completed', 'complete', 'resolved', 'rejected', 'superseded', 'cancelled', 'canceled', 'merged', 'wontfix'].includes(s);
      return filters.status === 'closed' ? terminal : !terminal;
    });
  }
  return out;
}

/** Adapt the MCP TrackerItem DTO into a canonical TrackerRecord. */
function mcpItemToRecord(item: any): TrackerRecord {
  const fields: Record<string, unknown> = {};
  const FIELD_KEYS = ['title', 'status', 'priority', 'owner', 'description', 'tags', 'dueDate', 'progress', 'labels'];
  for (const k of FIELD_KEYS) {
    if (item[k] !== undefined) fields[k] = item[k];
  }
  if (item.customFields && typeof item.customFields === 'object') {
    for (const [k, v] of Object.entries(item.customFields)) {
      if (v !== undefined) fields[k] = v;
    }
  }
  return {
    id: item.id,
    primaryType: item.type,
    typeTags: Array.isArray(item.typeTags) ? item.typeTags : [item.type],
    issueNumber: item.issueNumber,
    issueKey: item.issueKey,
    source: item.source ?? 'native',
    sourceRef: item.sourceRef,
    archived: item.archived ?? false,
    syncStatus: item.syncStatus ?? 'local',
    content: item.content,
    system: {
      workspace: item.workspace,
      documentPath: item.module || undefined,
      lineNumber: item.lineNumber,
      createdAt: item.created ?? new Date().toISOString(),
      updatedAt: item.updated ?? new Date().toISOString(),
      linkedSessions: item.linkedSessions,
      linkedCommitSha: item.linkedCommitSha,
      origin: item.origin,
    },
    fields,
  };
}
