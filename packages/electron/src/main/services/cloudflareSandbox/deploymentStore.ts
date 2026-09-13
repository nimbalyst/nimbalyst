/**
 * The saved record of this installation's sandbox deployment.
 *
 * Only non-secret metadata is persisted: which profile and account it belongs
 * to, the Worker name, when it was deployed. No token, no account credential,
 * nothing that could be replayed if the file were copied.
 *
 * Its own electron-store instance rather than a key in the shared app settings
 * registry, so this slice owns its file outright and does not contend with
 * other sessions over a central schema.
 *
 * `revision` is what makes lifecycle requests safe. It changes on every write,
 * and every lifecycle request must carry the revision it was rendered from. A
 * second window holding a stale record therefore fails with `deployment-stale`
 * instead of stopping or deleting a sandbox that has since been repointed at a
 * different account.
 */

import { randomUUID } from "crypto";
import Store from "../../utils/privateSettingsStore";

import type {
  SandboxContainerState,
  SandboxDeployment,
  SandboxDeploymentStatus,
  SandboxDeploymentTarget,
  SandboxNodeState,
} from "../../../shared/cloudflareSandbox";
import { SandboxOperationError } from "./errors";

interface PersistedDeployment {
  deploymentId: string;
  revision: string;
  status: SandboxDeploymentStatus;
  profileName: string;
  accountId: string;
  accountName: string;
  workerName: string;
  deployedAt: string | null;
  errorMessage: string | null;
  container: SandboxContainerState;
  /**
   * Absent on every record written before nodes existed, and absent again once
   * the node's credential is confirmed revoked. Read through `toContract`,
   * never directly, so an older record does not surface as `undefined`.
   *
   * Identity only. No observation is stored here: see `PersistedNodeRecord`.
   */
  node?: PersistedNodeRecord;
}

/**
 * What the desktop is allowed to keep about a node.
 *
 * `nodeId` is the whole reason this record exists — it is the only handle for
 * revoking a credential that lives on the server and outlives the container.
 * Everything else is here because the UI has to say which workspace and branch
 * the node was connected for.
 *
 * Explicitly NOT here: the access or refresh token, the encryption seed, the
 * Claude credential, the repo URL, and any live observation of the process
 * (`running`, `exitCode`, `recentLog`). Observations belong in the IPC
 * response, not on disk.
 */
interface PersistedNodeRecord {
  nodeId: string | null;
  deviceId: string | null;
  provisionedAt: string | null;
  workspace: { projectId: string; branch: string } | null;
}

interface StoreSchema {
  deployment?: PersistedDeployment;
  /**
   * Stable per-installation id. The Worker name is derived from it so two
   * Nimbalyst installations signed into the same Cloudflare account cannot
   * deploy the same Worker and end up sharing one `personal` Durable Object.
   */
  installationId?: string;
  /**
   * Node ids whose credential this desktop issued and could not revoke. Outside
   * `deployment` so a delete or redeploy cannot lose them. See
   * `readPendingRevocations`.
   */
  pendingRevocations?: string[];
}

let store: Store<StoreSchema> | null = null;

// Lazy: electron-store resolves app.getPath('userData') at construction, which
// is not available at module load. See MAIN_PROCESS_INIT.md.
function getStore(): Store<StoreSchema> {
  if (!store) {
    store = new Store<StoreSchema>({ name: "cloudflare-sandbox" });
  }
  return store;
}

/** Test-only. */
export function __setDeploymentStoreForTests(
  next: Store<StoreSchema> | null
): void {
  store = next;
}

/** Create the installation id on first use and never change it after. */
export function getInstallationId(): string {
  const existing = getStore().get("installationId");
  if (typeof existing === "string" && existing) return existing;
  const created = randomUUID();
  getStore().set("installationId", created);
  return created;
}

const NEVER_OBSERVED: SandboxContainerState = {
  status: "unknown",
  observedAt: null,
  message: null,
};

/**
 * Every field a node record can carry, so a record persisted by an older build
 * gains new fields as nulls rather than as `undefined`. See STATE_PERSISTENCE.md.
 */
function createDefaultNodeRecord(): PersistedNodeRecord {
  return { nodeId: null, deviceId: null, provisionedAt: null, workspace: null };
}

/**
 * Expand the stored identity into the contract shape.
 *
 * The observation half is always the "not running" default. Callers that have
 * actually looked at the container overlay their reading onto the response;
 * nothing writes it back. A record loaded from disk therefore never claims a
 * process is running, which is the honest answer, because the container may
 * have slept any time since it was written.
 */
function toNodeContract(saved: PersistedNodeRecord | undefined): SandboxNodeState | null {
  if (!saved) return null;
  const defaults = createDefaultNodeRecord();
  return {
    running: false,
    processId: null,
    startedAt: null,
    exitCode: null,
    recentLog: "",
    nodeId: saved.nodeId ?? defaults.nodeId,
    deviceId: saved.deviceId ?? defaults.deviceId,
    provisionedAt: saved.provisionedAt ?? defaults.provisionedAt,
    workspace: saved.workspace
      ? {
          projectId: saved.workspace.projectId ?? "",
          branch: saved.workspace.branch ?? "",
        }
      : defaults.workspace,
  };
}

export function readDeployment(): SandboxDeployment | null {
  const saved = getStore().get("deployment");
  return saved ? toContract(saved) : null;
}

export interface CreateDeploymentInput {
  /** Reuse an existing id when re-saving a deployment already in flight. */
  deploymentId?: string;
  profileName: string;
  accountId: string;
  accountName: string;
  workerName: string;
  status: SandboxDeploymentStatus;
  deployedAt: string | null;
  errorMessage?: string | null;
}

/** Replace the saved record wholesale. Used when a deploy completes. */
export function writeDeployment(
  input: CreateDeploymentInput
): SandboxDeployment {
  const existing = getStore().get("deployment");
  const record: PersistedDeployment = {
    // Keep the id stable across redeploys of the same worker in the same
    // account: it identifies the sandbox, not the deploy event.
    deploymentId:
      input.deploymentId ??
      (existing &&
      existing.accountId === input.accountId &&
      existing.workerName === input.workerName
        ? existing.deploymentId
        : randomUUID()),
    revision: randomUUID(),
    status: input.status,
    profileName: input.profileName,
    accountId: input.accountId,
    accountName: input.accountName,
    workerName: input.workerName,
    deployedAt: input.deployedAt,
    errorMessage: input.errorMessage ?? null,
    container: existing?.container ?? NEVER_OBSERVED,
    // Carried over deliberately. A deploy replaces the Worker and its
    // container, but it does NOT invalidate anything on the sync server: the
    // node's credential is still live and `nodeId` is the only handle for
    // revoking it. Dropping the record here (as an earlier version did, at the
    // *start* of a deploy that might then fail) orphaned that credential with
    // nothing left pointing at it. The process observation is not stored at
    // all, so nothing carried forward can claim a node is running.
    node: existing?.node,
  };
  getStore().set("deployment", record);
  return toContract(record);
}

/**
 * Record what was provisioned. Takes identity only, by type: there is no way to
 * hand this an observation, so no caller can accidentally persist one.
 */
export function updateDeploymentNode(patch: Partial<PersistedNodeRecord>): SandboxDeployment {
  const existing = getStore().get("deployment");
  if (!existing) {
    throw new SandboxOperationError("deployment-stale", "node-update-without-record");
  }
  const record: PersistedDeployment = {
    ...existing,
    node: { ...createDefaultNodeRecord(), ...(existing.node ?? {}), ...patch },
    revision: randomUUID(),
  };
  getStore().set("deployment", record);
  return toContract(record);
}

/** Forget the node entirely. Used once its credential has been revoked. */
export function clearDeploymentNode(): SandboxDeployment {
  const existing = getStore().get("deployment");
  if (!existing) {
    throw new SandboxOperationError("deployment-stale", "node-clear-without-record");
  }
  const { node: _dropped, ...rest } = existing;
  const record: PersistedDeployment = { ...rest, revision: randomUUID() };
  getStore().set("deployment", record);
  return toContract(record);
}

/** The saved node id, needed to revoke its credential. */
export function readNodeId(): string | null {
  return getStore().get("deployment")?.node?.nodeId ?? null;
}

/**
 * Node ids whose revocation was attempted and failed.
 *
 * Kept outside the deployment record on purpose: the whole point is that they
 * survive the deployment being replaced or deleted, which is exactly when a
 * half-cleaned-up credential is easiest to lose track of. Ids only, never a
 * token, and never more than a handful.
 */
/**
 * How much outstanding cleanup is tolerated before this desktop stops issuing
 * new credentials.
 *
 * This is a gate on ISSUANCE, not a cap that evicts. An earlier version kept
 * the newest 20 and dropped the oldest, which quietly destroyed the only record
 * of a credential that was still live on the server: exactly the thing the
 * queue exists to prevent. Nothing is ever evicted to make room.
 */
export const PENDING_REVOCATION_CAPACITY = 20;

/**
 * Structural ceiling, well above the issuance gate. Reaching it means something
 * is badly wrong, and at that point refusing the write is better than growing a
 * settings file without bound.
 */
const PENDING_REVOCATION_HARD_LIMIT = 64;

/**
 * `node_id` comes off the wire. It is persisted, so it gets the same treatment
 * as any other stored identifier: a shape, and a length. The server mints
 * base64url ids; anything else is not one of ours and does not go on disk.
 */
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidNodeId(nodeId: unknown): nodeId is string {
  return typeof nodeId === "string" && NODE_ID_PATTERN.test(nodeId);
}

export function readPendingRevocations(): string[] {
  const saved = getStore().get("pendingRevocations");
  return Array.isArray(saved) ? saved.filter(isValidNodeId) : [];
}

/** True when the cleanup backlog is deep enough to stop issuing. */
export function pendingRevocationsAtCapacity(): boolean {
  return readPendingRevocations().length >= PENDING_REVOCATION_CAPACITY;
}

/** Returns false when the id could not be stored. Never evicts to make room. */
export function recordPendingRevocation(nodeId: string): boolean {
  if (!isValidNodeId(nodeId)) return false;
  const existing = readPendingRevocations();
  if (existing.includes(nodeId)) return true;
  if (existing.length >= PENDING_REVOCATION_HARD_LIMIT) return false;
  getStore().set("pendingRevocations", [...existing, nodeId]);
  return true;
}

export function clearPendingRevocation(nodeId: string): void {
  const remaining = readPendingRevocations().filter((id) => id !== nodeId);
  getStore().set("pendingRevocations", remaining);
}

/**
 * Drop the saved node record once its credential is confirmed revoked.
 *
 * Matched on id so a record replaced underneath this call is left alone. See
 * `confirmRevoked` in nodeProvisioner: leaving a revoked id in the record makes
 * every later attempt re-revoke a dead credential.
 */
export function clearRevokedNode(nodeId: string): void {
  const existing = getStore().get("deployment");
  if (!existing?.node || existing.node.nodeId !== nodeId) return;
  const { node: _revoked, ...rest } = existing;
  getStore().set("deployment", { ...rest, revision: randomUUID() });
}

/** Patch the saved record, bumping the revision. Throws if none exists. */
export function updateDeployment(
  patch: Partial<
    Pick<PersistedDeployment, "status" | "errorMessage" | "container">
  >
): SandboxDeployment {
  const existing = getStore().get("deployment");
  if (!existing) {
    throw new SandboxOperationError(
      "deployment-stale",
      "update-without-record"
    );
  }
  const record: PersistedDeployment = {
    ...existing,
    ...patch,
    revision: randomUUID(),
  };
  getStore().set("deployment", record);
  return toContract(record);
}

/**
 * Patch the record only if its revision is still `expectedRevision`.
 *
 * Returns null when the record changed or vanished while the caller was doing
 * something slow. Used by passive observation: an unconditional write there
 * would stamp an old container reading onto whatever deployment now owns the
 * single saved slot.
 */
export function updateDeploymentIfUnchanged(
  expectedRevision: string,
  patch: Partial<
    Pick<PersistedDeployment, "status" | "errorMessage" | "container">
  >
): SandboxDeployment | null {
  const existing = getStore().get("deployment");
  if (!existing || existing.revision !== expectedRevision) return null;
  return updateDeployment(patch);
}

export function clearDeployment(): void {
  getStore().delete("deployment");
}

/** The Worker name of the saved deployment, needed to address it. */
export function readWorkerName(): string | null {
  return getStore().get("deployment")?.workerName ?? null;
}

/**
 * Assert a lifecycle request matches the saved record on every field, and
 * return that record.
 *
 * Checking all four fields rather than just the revision is deliberate. The
 * revision alone would catch a stale window, but not a request whose account
 * was rewritten in transit; on a destructive path the cheap extra comparisons
 * are worth having.
 */
export function requireTarget(
  target: SandboxDeploymentTarget
): SandboxDeployment {
  const saved = getStore().get("deployment");
  if (!saved) {
    throw new SandboxOperationError(
      "deployment-stale",
      "lifecycle-without-record"
    );
  }
  const mismatch =
    saved.deploymentId !== target.deploymentId ||
    saved.revision !== target.revision ||
    saved.profileName !== target.profileName ||
    saved.accountId !== target.accountId;

  if (mismatch) {
    throw new SandboxOperationError(
      "deployment-stale",
      "lifecycle-target-mismatch"
    );
  }
  return toContract(saved);
}

function toContract(record: PersistedDeployment): SandboxDeployment {
  return {
    deploymentId: record.deploymentId,
    revision: record.revision,
    status: record.status,
    container: record.container,
    node: toNodeContract(record.node),
    profileName: record.profileName,
    account: { id: record.accountId, name: record.accountName },
    // The control path is a private Worker RPC binding, so there is no public
    // URL by design. Null here is the expected value, not a missing one.
    access: "private-rpc",
    url: null,
    deployedAt: record.deployedAt,
    errorMessage: record.errorMessage,
  };
}
