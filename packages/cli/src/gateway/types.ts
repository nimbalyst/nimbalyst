/**
 * The single interface both access modes implement. Command code is written
 * against `TrackerGateway` and never branches on mode.
 */
import type { TrackerRecord } from '../vendor/trackerRecord.js';

export type GatewayMode = 'live' | 'direct';

export interface WhereClause {
  field: string;
  op: '=' | '!=' | '~' | 'in';
  value: string;
}

export interface ListFilters {
  workspace: string;
  type?: string;
  typeTag?: string;
  /** explicit status, or meta-values 'open' / 'closed' */
  status?: string;
  priority?: string;
  owner?: string;
  search?: string;
  since?: string; // ISO bound
  until?: string; // ISO bound
  dateField?: 'updated' | 'created';
  where?: WhereClause[];
  includeArchived?: boolean;
  limit?: number; // undefined = use default; Infinity-ish via --all handled by caller
}

export interface TrackerTypeSummary {
  type: string;
  displayName?: string;
  builtin?: boolean;
  count?: number;
  defaultColumns?: string[];
}

export interface GatewayStatus {
  mode: GatewayMode;
  schemaVersion: number | null;
  dbPath?: string;
  endpoint?: { pid: number; port: number; startedAt?: string };
  workspaces?: { path: string; name?: string }[];
}

export interface CreateInput {
  type: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  owner?: string;
  dueDate?: string;
  progress?: number;
  tags?: string[];
  labels?: string[];
  typeTags?: string[];
  linkedCommitSha?: string;
  fields?: Record<string, unknown>;
  linkSession?: boolean;
}

export interface UpdateInput {
  title?: string;
  status?: string;
  priority?: string;
  description?: string;
  owner?: string;
  dueDate?: string;
  progress?: number;
  tags?: string[];
  labels?: string[];
  typeTags?: string[];
  primaryType?: string;
  archived?: boolean;
  linkedCommitSha?: string;
  fields?: Record<string, unknown>;
  unsetFields?: string[];
}

// ---- importers (phase 3) ---------------------------------------------------

export interface ImporterInfo {
  id: string;
  displayName: string;
  urnScheme: string;
  importsAs?: string[];
  icon?: string;
}

export interface ImporterSearchEntry {
  externalId: string;
  urn: string;
  url: string;
  title: string;
  state: string;
  updatedAt: string;
}

export interface ImporterSearchResult {
  binding?: string;
  items: ImporterSearchEntry[];
  nextCursor?: string;
}

export interface ImporterSearchOptions {
  providerId: string;
  bindingId?: string;
  search?: string;
  state?: string;
  limit?: number;
}

export interface ImportOptions {
  providerId: string;
  externalId: string;
  primaryType?: string;
}

export interface ImportResult {
  id: string;
  urn: string;
  created: boolean;
  summary?: string;
}

export interface ResnapshotResult {
  id: string;
  urn: string;
  titleUpdated?: boolean;
  statusUpdated?: boolean;
  bodyChanged?: boolean;
  summary?: string;
}

export interface TrackerGateway {
  readonly mode: GatewayMode;

  status(): Promise<GatewayStatus>;

  /** Workspaces this gateway can see (for resolution + `nim workspace list`). */
  listWorkspaces(): Promise<{ path: string; name?: string }[]>;

  listTrackers(filters: ListFilters): Promise<TrackerRecord[]>;

  /** Resolve by id or issue key. Returns null if not found. */
  getTracker(workspace: string, reference: string): Promise<TrackerRecord | null>;

  /** Resolve by external URN (e.g. github://owner/repo#42). */
  getTrackerByUrn(workspace: string, urn: string): Promise<TrackerRecord | null>;

  /** Markdown body for an item (from tracker_body_cache / live tool). */
  getTrackerBody(workspace: string, record: TrackerRecord): Promise<string | undefined>;

  listTypes(workspace: string): Promise<TrackerTypeSummary[]>;

  // ---- writes (phase 2) ----------------------------------------------------

  createTracker(workspace: string, input: CreateInput): Promise<TrackerRecord>;

  updateTracker(workspace: string, reference: string, input: UpdateInput): Promise<TrackerRecord>;

  commentTracker(workspace: string, reference: string, body: string): Promise<void>;

  setArchived(workspace: string, reference: string, archived: boolean): Promise<TrackerRecord>;

  linkSession(workspace: string, reference: string, sessionId?: string): Promise<void>;

  defineType(workspace: string, schema: Record<string, unknown>, fileName?: string): Promise<void>;

  deleteType(workspace: string, type: string): Promise<void>;

  // ---- importers (phase 3; live mode only) ---------------------------------

  importerList(workspace: string): Promise<ImporterInfo[]>;

  importerSearch(workspace: string, opts: ImporterSearchOptions): Promise<ImporterSearchResult>;

  importItem(workspace: string, opts: ImportOptions): Promise<ImportResult>;

  resnapshot(workspace: string, urn: string): Promise<ResnapshotResult>;

  close(): void;
}
