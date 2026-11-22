import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dialog, net } from 'electron';
import { stripLocalOnlyFields } from '@nimbalyst/tracker-engine';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { safeHandle } from '../utils/ipcRegistry';
import PrivateSettingsStore from '../utils/privateSettingsStore';
import { getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import { getDatabase } from '../database/initialize';
import { getAccounts, isAuthenticated, onAuthStateChange } from './StytchAuthService';
import { getOrgScopedIdentity, resolveTeamForWorkspace } from './TeamService';
import { getCollabDocumentReplicaStore } from './CollabDocumentReplicaStore';
import { getCollabAssetStore } from './CollabAssetStore';
import { withLegacyRecoveryKeys } from './LegacyRecoveryKeyFiles';
import { resolveTrackerSharingPolicy, shouldSyncTrackerItem } from './TrackerPolicyService';
import { trackerItemToPayload } from './TrackerSyncManager';
import { rowToTrackerItem } from '../mcp/tools/trackerToolHandlers';
import { invalidateTeamKeyStatusCache } from './TeamCustodyService';
import { TeamRecoveryClient, validateRecoveryDiagnostics } from './TeamRecoveryClient';
import { collectRecoverySources } from './TeamRecoverySources';
import { writeRecoveryBundle, readRecoveryBundle, exclusiveCreateError } from './TeamRecoveryBundle';
import type { TeamRecoveryCommand } from '../../shared/teamRecovery';

let settings: PrivateSettingsStore<{ clientId: string }> | null = null;
let cachedClientId: string | null = null;
function clientId(): string {
  if (cachedClientId) return cachedClientId;
  settings ??= new PrivateSettingsStore({ name: 'team-recovery', defaults: { clientId: '' } });
  const existing = settings.get('clientId');
  cachedClientId = existing || randomUUID();
  if (!existing) settings.set('clientId', cachedClientId);
  return cachedClientId;
}
// Holds decrypted organization content between steps of one recovery session.
// Dropped on release (the settings section unmounts or switches organization),
// on sign-out, and once an operation completes. Nothing here is durable: the
// server keeps the operation and its checkpoints, and resuming always imports
// the saved bundle again.
const clients = new Map<string, TeamRecoveryClient>();
const busy = new Set<string>();
const commands = new Set<TeamRecoveryCommand>(['inspect', 'collect', 'save', 'import', 'restore', 'verify', 'status', 'reset', 'export-diagnostics', 'release']);

function releaseClients(orgId: string): void {
  for (const [key, client] of clients) if (client.orgId === orgId) clients.delete(key);
}

// Unique by default, because the OS dialog's "Replace" cannot succeed: recovery never overwrites a file.
const timestamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

function createClient(orgId: string, memberId: TeamMemberId): TeamRecoveryClient {
  const api = async (path: string, body?: Record<string, unknown>) => {
    if (!isAuthenticated()) throw new Error('Sign in before continuing organization recovery');
    const identity = await getOrgScopedIdentity(orgId);
    if (identity.teamMemberId !== memberId) throw new Error('The signed-in team account changed; reopen organization recovery');
    const response = await net.fetch(`${getCollabSyncHttpUrl()}/api/teams/${encodeURIComponent(orgId)}/key-recovery/${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${identity.jwt}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error || `Recovery request failed (${response.status})`);
    return result;
  };
  return new TeamRecoveryClient(orgId, {
    api, clientId,
    collect: async (workspacePath, inventory) => {
      if (!workspacePath) throw new Error('Choose the folder linked to this organization');
      const resolved = await resolveTeamForWorkspace(workspacePath);
      const team = resolved.team;
      if (!resolved.complete || !team || team.orgId !== orgId || !team.teamProjectId) throw new Error('The selected folder is not verifiably linked to this organization and project');
      const accountOrgId = team.boundPersonalOrgId ?? team.owningPersonalOrgId ?? team.sourcePersonalOrgId;
      const account = getAccounts().find(entry => entry.personalOrgId === accountOrgId && entry.sessionStatus === 'active');
      if (!account?.personalUserId) throw new Error('Sign in to the account bound to this shared folder before collecting its replicas');
      const identity = await getOrgScopedIdentity(orgId, accountOrgId);
      if (identity.teamMemberId !== memberId) throw new Error('This folder belongs to another signed-in team account');
      const db = getDatabase();
      if (!db) throw new Error('Local database is unavailable');
      const project = inventory.diagnostics.projects.find(entry => entry.teamProjectId === team.teamProjectId);
      if (!project) throw new Error('The folder’s project is absent from the inspected organization');
      const primaryProjectId = inventory.diagnostics.primaryProjectId ?? (inventory.diagnostics.projects.length === 1 ? project.teamProjectId : undefined);
      const documents = inventory.rooms.find(room => room.kind === 'documents')?.entries.filter(row => row.projectId === project.projectId || row.projectId == null && project.teamProjectId === primaryProjectId).map(row => row.id) ?? [];
      return collectRecoverySources({ orgId, accountId: account.personalUserId, workspacePath, teamProjectId: team.teamProjectId,
        primaryProjectId,
        query: (sql, params) => db.query(sql, params),
        sharing: type => { const policy = resolveTrackerSharingPolicy(workspacePath, type); return policy.known ? policy.policy.sharing : 'unknown'; },
        includeItem: row => {
          const policy = resolveTrackerSharingPolicy(workspacePath, String(row.type));
          if (!policy.known) throw new Error('Load the tracker sharing policy before recovery');
          return shouldSyncTrackerItem(policy.policy, typeof row.data === 'string' ? JSON.parse(row.data) : row.data as Record<string, unknown>);
        }, documentIds: documents,
        readReplica: documentId => getCollabDocumentReplicaStore().load({ accountId: account.personalUserId!, orgId, documentId }, { readOnly: true }),
        readAsset: (documentId, assetId) => getCollabAssetStore().loadAsset({ accountId: account.personalUserId!, orgId, documentId, assetId }, { readOnly: true }),
      });
    },
    withKeys: action => withLegacyRecoveryKeys(orgId, action),
    itemPayload: row => {
      const item = rowToTrackerItem({ ...row, archived: row.archived === true || row.archived === 1 });
      // A legacy label array has no CRDT IDs. Rehearsing it on two devices must
      // produce the same source, rather than minting random IDs on every read.
      if (!item.labelsMap) item.labelsMap = Object.fromEntries((item.labels ?? []).map((value: string) => {
        const id = `recovery-${createHash('sha256').update(JSON.stringify([orgId, item.id, value])).digest('hex')}`;
        return [id, { id, value }];
      }));
      return JSON.stringify(stripLocalOnlyFields(trackerItemToPayload(item)));
    },
    saveFile: async () => (await dialog.showSaveDialog({ title: 'Save encrypted organization recovery bundle', defaultPath: `organization-recovery-${timestamp()}.nimrecovery`, filters: [{ name: 'Encrypted Nimbalyst recovery bundle', extensions: ['nimrecovery'] }] })).filePath ?? null,
    openFile: async () => (await dialog.showOpenDialog({ title: 'Import encrypted recovery bundle', properties: ['openFile'], filters: [{ name: 'Encrypted Nimbalyst recovery bundle', extensions: ['nimrecovery'] }] })).filePaths[0] ?? null,
    writeBundle: writeRecoveryBundle,
    readBundle: (filename, password) => readRecoveryBundle(filename, password, orgId),
  });
}

export function registerTeamRecoveryHandlers(): void {
  onAuthStateChange(state => { if (!state.isAuthenticated) clients.clear(); });
  safeHandle('team:recovery', async (_event, orgId: string, command: TeamRecoveryCommand, options: { workspacePath?: string; password?: string } = {}) => {
    let key: string | undefined;
    let ownsAction = false;
    let client: TeamRecoveryClient | undefined;
    try {
      if (typeof orgId !== 'string' || !orgId || orgId.length > 256 || !commands.has(command)) throw new Error('Explicit organization and recovery action required');
      // Releasing only forgets in-memory state, so it needs no credentials and works after sign-out.
      if (command === 'release') { releaseClients(orgId); return { success: true }; }
      if (!isAuthenticated()) throw new Error('Sign in before continuing organization recovery');
      const identity = await getOrgScopedIdentity(orgId);
      key = `${orgId}:${identity.teamMemberId}`;
      if (busy.has(key)) throw new Error('A recovery action is already running for this organization');
      busy.add(key);
      ownsAction = true;
      client = clients.get(key);
      if (!client) { client = createClient(orgId, identity.teamMemberId); clients.set(key, client); }
      // The server rechecks administrator authority for every action, including local key/source collection.
      const response = await net.fetch(`${getCollabSyncHttpUrl()}/api/teams/${encodeURIComponent(orgId)}/key-recovery/diagnostics`, { headers: { Authorization: `Bearer ${identity.jwt}` } });
      if (!response.ok) throw new Error(response.status === 403 ? 'An organization owner or administrator must run recovery' : 'Recovery diagnostics are unavailable; retry when the service is reachable');
      let overview;
      if (command === 'export-diagnostics') {
        const diagnostics = validateRecoveryDiagnostics(await response.json(), orgId);
        overview = client.overview();
        // Explicit fields only: never serialize source bundles, raw errors,
        // authentication, local paths, or future response fields into support reports.
        const report = { version: 1, orgId, exportedAt: new Date().toISOString(), diagnostics: {
          status: diagnostics.status, rawCustodyMode: diagnostics.rawCustodyMode,
          keyPresent: diagnostics.keyPresent, keyProbe: diagnostics.keyProbe,
          dekEpoch: diagnostics.dekEpoch, dekFingerprint: diagnostics.dekFingerprint,
          projects: diagnostics.projects.map(project => ({ projectId: project.projectId, teamProjectId: project.teamProjectId })),
        }, counts: overview.counts, blockers: overview.blockers,
        operation: overview.operation ? { operationId: overview.operation.operationId, phase: overview.operation.phase,
          restored: overview.operation.rooms.filter(room => room.restored).length,
          verified: overview.operation.rooms.filter(room => room.verified).length,
          total: overview.operation.rooms.length } : null };
        const selected = await dialog.showSaveDialog({ title: 'Export content-free recovery diagnostics', defaultPath: `organization-recovery-diagnostics-${timestamp()}.json`, filters: [{ name: 'Recovery diagnostics', extensions: ['json'] }] });
        if (selected.filePath) {
          try { await writeFile(selected.filePath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
          catch (error) { throw exclusiveCreateError(error, 'A file with that name already exists. Recovery never overwrites an existing file; choose a new name.'); }
        }
      } else if (command === 'inspect') overview = await client.inspect();
      else if (command === 'reset') overview = await client.reset();
      else if (command === 'status') overview = await client.status();
      else if (command === 'collect') {
        const workspacePath = options.workspacePath ?? (await dialog.showOpenDialog({ title: 'Choose a folder linked to this organization', properties: ['openDirectory'] })).filePaths[0];
        overview = workspacePath ? await client.collect(workspacePath) : client.overview();
      } else if (command === 'save') overview = await client.save(options.password ?? '');
      else if (command === 'import') overview = await client.import(options.password ?? '');
      else if (command === 'restore') overview = await client.restore(options.password ?? '');
      else overview = await client.verify(options.password ?? '');
      if (overview.operation?.phase === 'completed') {
        invalidateTeamKeyStatusCache(orgId);
        // Sync now runs normally; the reviewed plaintext has no further use in memory.
        if (key) clients.delete(key);
      }
      return { success: true, overview };
    } catch (error) { return { success: false, ...(client && ownsAction ? { overview: client.overview() } : {}), error: error instanceof Error ? error.message : 'Organization recovery failed' }; }
    finally { if (key && ownsAction) busy.delete(key); }
  });
}
