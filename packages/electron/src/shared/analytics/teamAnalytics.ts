export const TEAM_ANALYTICS_CONTRACT_VERSION = 1 as const;

const booleanRule = { type: 'boolean' } as const;
const categoryRule = { type: 'category' } as const;
const enumRule = <const T extends readonly string[]>(...values: T) => ({ type: 'enum', values } as const);

const surface = enumRule('desktop', 'web_console', 'ios');
const actorType = enumRule('user', 'agent');
const callerRole = enumRule('owner', 'admin', 'member', 'unknown');
const collaborationScope = enumRule('personal', 'shared', 'mixed', 'unknown');
const connectionPath = enumRule('initial', 'reconnect', 'offline_open', 'resume');
const encryptionMode = enumRule('server_managed', 'legacy_e2e', 'unknown');
const outcome = enumRule('success', 'partial', 'failed', 'cancelled', 'offline_ready');
const durationCategory = enumRule('fast', 'medium', 'slow');
const memberCountBucket = enumRule('1', '2-3', '4-10', '11-25', '26+');
const projectCountBucket = enumRule('1', '2-3', '4-10', '11+');
const itemCountBucket = enumRule('0', '1', '2-5', '6-20', '21+');
const retryCountBucket = enumRule('0', '1', '2-3', '4+');
const queryLengthBucket = enumRule('1-3', '4-10', '11-30', '31+');
const resourceType = enumRule('team_index', 'document', 'tracker', 'asset');
/**
 * Every route that can open a shared document. `share_to_team` and
 * `embedded_document` are distinct entries rather than being folded into
 * `home`: they are creation flows that auto-open their result, and collapsing
 * them would inflate the Shared Docs home numbers on the adoption dashboard.
 */
const documentOpenSource = enumRule(
  'sidebar',
  'home',
  'quick_open',
  'deep_link',
  'restart_restore',
  'history',
  'agent_tool',
  'share_to_team',
  'embedded_document',
);
const teamErrorCategory = enumRule(
  'not_signed_in',
  'not_authorized',
  'invite_invalid',
  'member_limit',
  'last_owner',
  'conflict',
  'network',
  'server',
  'unknown',
);
const projectErrorCategory = enumRule(
  'no_git_remote',
  'not_authorized',
  'already_attached',
  'identity_conflict',
  'destination_invalid',
  'network',
  'server',
  'unknown',
);
const collabErrorCategory = enumRule(
  'unsupported_type',
  'source_read_failed',
  'asset_migration_failed',
  'linked_document_failed',
  'registration_failed',
  'open_failed',
  'permission',
  'network',
  'server',
  'unknown',
);
const syncErrorCategory = enumRule(
  'auth',
  'key_unavailable',
  'room_not_found',
  'protocol',
  'decrypt',
  'rejected',
  'network',
  'timeout',
  'server',
  'unknown',
);

type PropertyRule =
  | typeof booleanRule
  | typeof categoryRule
  | ReturnType<typeof enumRule<readonly string[]>>;

export const TEAM_ANALYTICS_EVENT_SCHEMAS = {
  team_surface_opened: {
    surface,
    entryPoint: enumRule('account_org_list', 'org_switcher', 'project_sharing', 'deep_link'),
    hasActiveOrganization: booleanRule,
    callerRole,
  },
  team_organization_created: {
    surface,
    entryPoint: enumRule('account_org_list', 'organization_manager', 'project_sharing'),
    projectAttached: booleanRule,
    encryptionMode,
    memberCountBucket,
    projectCountBucket,
  },
  team_organization_switched: {
    surface,
    entryPoint: enumRule('org_switcher'),
    callerRole,
  },
  team_invitation_sent: {
    surface,
    entryPoint: enumRule('organization_manager', 'project_sharing'),
    callerRole,
    memberCountBucket,
  },
  team_invitation_accepted: {
    surface,
    entryPoint: enumRule('organization_manager', 'project_sharing'),
    projectMatched: booleanRule,
  },
  team_member_role_changed: {
    surface,
    callerRole,
    fromRole: callerRole,
    toRole: callerRole,
  },
  team_member_removed: {
    surface,
    callerRole,
    memberState: enumRule('pending', 'active'),
  },
  team_organization_merged: {
    surface,
    callerRole,
    movedProjectCountBucket: projectCountBucket,
    mergedMemberCountBucket: memberCountBucket,
    destinationProjectCountBucket: projectCountBucket,
  },
  team_organization_deleted: {
    surface,
    callerRole,
    memberCountBucket,
    projectCountBucket,
  },
  team_operation_failed: {
    surface,
    operation: enumRule(
      'create_organization',
      'switch_organization',
      'send_invitation',
      'accept_invitation',
      'change_member_role',
      'remove_member',
      'add_project',
      'link_project',
      'unlink_project',
      'move_project',
      'change_project_access',
      'merge_organization',
      'delete_organization',
    ),
    entryPoint: enumRule('account_org_list', 'organization_manager', 'org_switcher', 'project_sharing'),
    callerRole,
    // Organization and project failures share this event, so the allowlist is
    // the union of both taxonomies with their overlapping members deduped.
    errorCategory: enumRule(...new Set([...teamErrorCategory.values, ...projectErrorCategory.values])),
  },
  team_project_added: {
    surface,
    entryPoint: enumRule('organization_manager', 'project_sharing'),
    callerRole,
    organizationWasNew: booleanRule,
    hasGitRemote: booleanRule,
    projectCountBucket,
  },
  team_project_identity_changed: {
    surface,
    action: enumRule('linked', 'unlinked'),
    callerRole,
    hasGitRemote: booleanRule,
  },
  team_project_moved: {
    surface,
    callerRole,
    transferMemberCountBucket: memberCountBucket,
    autoInviteCountBucket: memberCountBucket,
  },
  team_project_access_changed: {
    surface,
    action: enumRule('granted', 'revoked'),
    callerRole,
    targetRole: callerRole,
  },
  collab_home_opened: {
    surface,
    entryPoint: enumRule('navigation', 'empty_state', 'deep_link'),
    hasDocuments: booleanRule,
    unreadCountBucket: itemCountBucket,
    favoriteCountBucket: itemCountBucket,
  },
  collab_home_searched: {
    surface,
    queryLengthBucket,
    resultCountBucket: itemCountBucket,
  },
  collab_document_created: {
    surface,
    source: enumRule('new_document', 'share_to_team', 'agent_tool', 'embedded_document'),
    actorType,
    documentType: categoryRule,
    editorCategory: categoryRule,
    nested: booleanRule,
    linkedDocumentCountBucket: itemCountBucket,
    assetMigrationOutcome: enumRule('not_needed', 'success', 'partial', 'failed'),
  },
  collab_document_opened: {
    surface,
    source: documentOpenSource,
    actorType,
    documentType: categoryRule,
    editorCategory: categoryRule,
    wasUnread: booleanRule,
    connectionPath,
  },
  collab_document_first_edited: {
    surface,
    source: documentOpenSource,
    actorType,
    documentType: categoryRule,
    editorCategory: categoryRule,
    connectionPath,
    wasOffline: booleanRule,
  },
  collab_document_action: {
    surface,
    action: enumRule('renamed', 'moved', 'trashed', 'restored', 'favorite_enabled', 'favorite_disabled', 'marked_read', 'link_copied'),
    actorType,
    documentType: categoryRule,
    entryPoint: enumRule('sidebar', 'home', 'editor', 'context_menu', 'agent_tool'),
  },
  collab_operation_failed: {
    surface,
    operation: enumRule('create_document', 'open_document', 'edit_document', 'share_to_team', 'folder_action', 'document_action', 'search'),
    source: enumRule('new_document', 'share_to_team', 'embedded_document', 'sidebar', 'home', 'quick_open', 'deep_link', 'restart_restore', 'history', 'agent_tool', 'unknown'),
    actorType,
    documentType: categoryRule,
    errorCategory: collabErrorCategory,
  },
  collab_folder_created: {
    actorType,
    source: enumRule('sidebar', 'agent_tool'),
    nested: booleanRule,
  },
  collab_folder_renamed: {
    actorType,
    source: enumRule('sidebar', 'agent_tool', 'legacy_folder'),
  },
  collab_folder_moved: {
    actorType,
    source: enumRule('sidebar', 'agent_tool'),
    toRoot: booleanRule,
  },
  collab_folder_deleted: {
    actorType,
    source: enumRule('sidebar', 'agent_tool'),
    documentCountBucket: itemCountBucket,
    subfolderCountBucket: itemCountBucket,
  },
  collab_folder_link_copied: {
    actorType,
    entryPoint: enumRule('sidebar', 'context_menu', 'agent_tool'),
  },
  tracker_item_clicked: {
    collaborationScope,
    surface,
  },
  tracker_table_sort: {
    collaborationScope,
    surface,
  },
  tracker_item_mutated: {
    surface,
    actorType,
    action: enumRule('created', 'status_changed', 'field_changed', 'assigned', 'commented', 'deleted'),
    collaborationScope,
    trackerType: categoryRule,
    view: categoryRule,
  },
  tracker_item_scope_changed: {
    surface,
    actorType,
    fromScope: collaborationScope,
    toScope: collaborationScope,
    trackerType: categoryRule,
  },
  tracker_mutation_rejected: {
    surface,
    action: enumRule('created', 'status_changed', 'field_changed', 'assigned', 'commented', 'deleted', 'unknown'),
    trackerType: categoryRule,
    errorCategory: syncErrorCategory,
  },
  collab_sync_attempt_completed: {
    surface,
    resourceType,
    connectionPath,
    outcome,
    errorCategory: syncErrorCategory,
    durationCategory,
    retryCountBucket,
    encryptionMode,
    hadPendingOutbox: booleanRule,
  },
  collab_outbox_replay_completed: {
    surface,
    resourceType,
    outcome,
    errorCategory: syncErrorCategory,
    itemCountBucket,
    durationCategory,
    retryCountBucket,
  },
  collab_share_asset_migration_completed: {
    surface,
    outcome,
    assetCountBucket: itemCountBucket,
    linkedDocumentCountBucket: itemCountBucket,
    errorCategory: collabErrorCategory,
  },
  collab_server_mutation_rejected: {
    surface,
    resourceType,
    operation: categoryRule,
    errorCategory: syncErrorCategory,
    connectionPath,
  },
} as const satisfies Record<string, Record<string, PropertyRule>>;

type SchemaMap = typeof TEAM_ANALYTICS_EVENT_SCHEMAS;
export type TeamAnalyticsEventName = keyof SchemaMap;

type InferRule<T extends PropertyRule> =
  T extends { type: 'boolean' }
    ? boolean
    : T extends { type: 'enum'; values: readonly (infer V extends string)[] }
      ? V
      : string;

export type TeamAnalyticsProperties<E extends TeamAnalyticsEventName> = Partial<{
  [K in keyof SchemaMap[E]]: SchemaMap[E][K] extends PropertyRule ? InferRule<SchemaMap[E][K]> : never;
}>;

export interface TeamAnalyticsEvent<E extends TeamAnalyticsEventName = TeamAnalyticsEventName> {
  event: E;
  properties: TeamAnalyticsProperties<E>;
}

const PRIVACY_SHAPE = /(?:https?:\/\/|file:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:^|[\\/])(?:Users|home|var|tmp|private|Volumes)(?:[\\/]|$))/i;
const STABLE_CATEGORY = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

function assertPropertyValue(event: TeamAnalyticsEventName, key: string, rule: PropertyRule, value: unknown): void {
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${event}.${key} must be boolean`);
    return;
  }
  if (typeof value !== 'string') throw new Error(`${event}.${key} must be a string category`);
  if (PRIVACY_SHAPE.test(value)) throw new Error(`${event}.${key} contains a forbidden identifying value`);
  if (rule.type === 'enum') {
    if (!rule.values.includes(value)) throw new Error(`${event}.${key} is not an allowlisted category`);
    return;
  }
  if (!STABLE_CATEGORY.test(value) || value.includes('..') || value.startsWith('/')) {
    throw new Error(`${event}.${key} must be a stable low-cardinality category`);
  }
}

export function validateTeamAnalyticsEvent<E extends TeamAnalyticsEventName>(
  event: E,
  properties: TeamAnalyticsProperties<E>,
): TeamAnalyticsEvent<E> {
  const schema = TEAM_ANALYTICS_EVENT_SCHEMAS[event];
  if (!schema) throw new Error(`Unknown Teams analytics event: ${String(event)}`);
  for (const [key, value] of Object.entries(properties)) {
    const rule = (schema as Record<string, PropertyRule>)[key];
    if (!rule) throw new Error(`${event}.${key} is not an allowlisted property`);
    if (value !== undefined) assertPropertyValue(event, key, rule, value);
  }
  return { event, properties };
}

export function bucketMemberCount(count: number): '1' | '2-3' | '4-10' | '11-25' | '26+' {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 10) return '4-10';
  if (count <= 25) return '11-25';
  return '26+';
}

export function bucketProjectCount(count: number): '1' | '2-3' | '4-10' | '11+' {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 10) return '4-10';
  return '11+';
}

export function bucketItemCount(count: number): '0' | '1' | '2-5' | '6-20' | '21+' {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '21+';
}

export function bucketRetryCount(count: number): '0' | '1' | '2-3' | '4+' {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  return '4+';
}

export function bucketDuration(durationMs: number): 'fast' | 'medium' | 'slow' {
  if (durationMs < 1_000) return 'fast';
  if (durationMs < 5_000) return 'medium';
  return 'slow';
}

export function bucketQueryLength(length: number): '1-3' | '4-10' | '11-30' | '31+' {
  if (length <= 3) return '1-3';
  if (length <= 10) return '4-10';
  if (length <= 30) return '11-30';
  return '31+';
}

export function toStableAnalyticsCategory(value: string | null | undefined, fallback = 'unknown'): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9._+-]+/g, '_') ?? '';
  if (!normalized || !STABLE_CATEGORY.test(normalized) || normalized.includes('..')) {
    return fallback;
  }
  return normalized;
}

export type TeamAnalyticsErrorArea = 'organization' | 'project' | 'document' | 'sync';
type TeamErrorCategory = typeof teamErrorCategory.values[number] | 'network' | 'server' | 'unknown';
type ProjectErrorCategory = typeof projectErrorCategory.values[number];
type DocumentErrorCategory = typeof collabErrorCategory.values[number];
type SyncErrorCategory = typeof syncErrorCategory.values[number];
export type TeamAnalyticsErrorCategory =
  | TeamErrorCategory
  | ProjectErrorCategory
  | DocumentErrorCategory
  | SyncErrorCategory;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === 'string') return error.toLowerCase();
  if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string') return error.error.toLowerCase();
  return '';
}

export function categorizeTeamAnalyticsError(area: 'organization', error: unknown): TeamErrorCategory;
export function categorizeTeamAnalyticsError(area: 'project', error: unknown): ProjectErrorCategory;
export function categorizeTeamAnalyticsError(area: 'document', error: unknown): DocumentErrorCategory;
export function categorizeTeamAnalyticsError(area: 'sync', error: unknown): SyncErrorCategory;
export function categorizeTeamAnalyticsError(area: TeamAnalyticsErrorArea, error: unknown): TeamAnalyticsErrorCategory {
  const text = errorText(error);
  if (area === 'organization') {
    if (/sign.?in|session|unauthenticated/.test(text)) return 'not_signed_in';
    if (/forbidden|permission|unauthori[sz]ed/.test(text)) return 'not_authorized';
    if (/invalid.*invit|invit.*invalid|expired.*invit|invit.*expired/.test(text)) return 'invite_invalid';
    if (/member.*limit|seat.*limit/.test(text)) return 'member_limit';
    if (/last owner/.test(text)) return 'last_owner';
    if (/conflict|already exists|duplicate/.test(text)) return 'conflict';
  }
  if (area === 'project') {
    if (/git remote|no remote/.test(text)) return 'no_git_remote';
    if (/forbidden|permission|unauthori[sz]ed/.test(text)) return 'not_authorized';
    if (/already.*(?:attach|link)|already belongs/.test(text)) return 'already_attached';
    if (/identity|remote.*conflict/.test(text)) return 'identity_conflict';
    if (/destination|target organization/.test(text)) return 'destination_invalid';
  }
  if (area === 'document') {
    if (/unsupported|unknown.*type|codec/.test(text)) return 'unsupported_type';
    if (/read.*(?:source|file)|source.*read/.test(text)) return 'source_read_failed';
    if (/asset|attachment/.test(text)) return 'asset_migration_failed';
    if (/linked document/.test(text)) return 'linked_document_failed';
    if (/register|seed/.test(text)) return 'registration_failed';
    if (/open|tab/.test(text)) return 'open_failed';
    if (/forbidden|permission|unauthori[sz]ed/.test(text)) return 'permission';
  }
  if (area === 'sync') {
    if (/auth|jwt|session/.test(text)) return 'auth';
    if (/key.*(?:missing|unavailable)|encryption key/.test(text)) return 'key_unavailable';
    if (/room.*not found|unknown room/.test(text)) return 'room_not_found';
    if (/protocol|version mismatch|invalid message/.test(text)) return 'protocol';
    if (/decrypt|cipher/.test(text)) return 'decrypt';
    if (/reject|quarantine/.test(text)) return 'rejected';
    if (/timeout|timed out/.test(text)) return 'timeout';
  }
  if (/network|offline|fetch failed|econn|socket|websocket/.test(text)) return 'network';
  if (/server|internal|\b5\d\d\b/.test(text)) return 'server';
  return 'unknown';
}

export function teamPersonPropertiesForEvent<E extends TeamAnalyticsEventName>(
  event: E,
  properties: TeamAnalyticsProperties<E>,
): Record<string, true> | undefined {
  const setOnce: Record<string, true> = {};
  if (
    event === 'collab_document_created'
    || event === 'collab_document_first_edited'
    || (event === 'tracker_item_mutated' && (properties as TeamAnalyticsProperties<'tracker_item_mutated'>).collaborationScope === 'shared')
  ) setOnce.has_used_teams = true;
  if (event === 'team_organization_created') setOnce.has_created_team_organization = true;
  if (event === 'collab_document_opened' && (properties as TeamAnalyticsProperties<'collab_document_opened'>).source !== 'restart_restore') {
    setOnce.has_opened_shared_document = true;
  }
  if (event === 'collab_document_first_edited') setOnce.has_edited_shared_document = true;
  if (event === 'tracker_item_mutated' && (properties as TeamAnalyticsProperties<'tracker_item_mutated'>).collaborationScope === 'shared') {
    setOnce.has_used_shared_tracker = true;
  }
  return Object.keys(setOnce).length > 0 ? setOnce : undefined;
}

export function buildTeamAnalyticsCapture<E extends TeamAnalyticsEventName>(
  event: E,
  properties: TeamAnalyticsProperties<E>,
): { event: E; properties: Record<string, unknown> } {
  const validated = validateTeamAnalyticsEvent(event, properties);
  const setOnce = teamPersonPropertiesForEvent(event, properties);
  return {
    event: validated.event,
    properties: {
      ...validated.properties,
      ...(setOnce ? { $set_once: setOnce } : {}),
    },
  };
}
