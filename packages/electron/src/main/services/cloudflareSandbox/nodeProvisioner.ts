/**
 * Turning a deployed-but-empty sandbox into a headless Nimbalyst node.
 *
 * The container's filesystem is ephemeral: it is discarded every time the
 * sandbox sleeps. So "connect the node" is not a one-time setup step, it is a
 * whole provisioning run — grant a credential, write four files, start the
 * process — and it has to be repeatable without leaving anything behind.
 *
 * Order is load-bearing:
 *
 *  1. **Read the Claude credential first.** It is the step most likely to fail
 *     (the user may never have signed in to Claude Code), it is purely local,
 *     and failing here means no credential was minted on the sync server that
 *     would then need revoking.
 *  2. **Revoke the previous node before minting a new one.** Otherwise every
 *     re-provision leaves another credential able to join the user's personal
 *     rooms, and the containers those belonged to are already gone.
 *  3. **Write, then start.** Provisioning without starting would leave the user
 *     looking at a state that evaporates on the next idle timeout.
 *
 * What crosses into the container is the user's own material: their Claude
 * subscription credential, their personal-sync encryption seed, and a node
 * credential minted for them. None of it is logged here, and none of it is
 * persisted on the desktop — `deploymentStore` keeps only the node id, the
 * device id, and a timestamp.
 */

import type { PersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";
import { SandboxOperationError } from "./errors";
import type { NodeCredential } from "./deviceGrantClient";
import type {
  SandboxControlClient,
  SandboxControlTarget,
  SandboxNodeStatus,
  SandboxProvisionRequest,
} from "./sandboxControl";

/**
 * Everything the node needs to join personal sync as this user's device.
 *
 * The org and user ids here are what the *desktop* believes it is. They are not
 * what gets written into the node's config: that comes from the grant response,
 * because the node's access token is rejected with AUTH_MISMATCH unless
 * `config.sync.personalUserId` equals the token's `sub`. These two are compared
 * so a disagreement fails loudly at connect time instead of as an unexplained
 * refusal to sync later.
 */
export interface NodeSyncIdentity {
  /** HTTPS form, e.g. `https://sync.nimbalyst.com`. */
  serverUrl: string;
  expectedPersonalOrgId: string;
  expectedPersonalUserId: PersonalMemberId;
  /** The desktop's personal-sync encryption seed, handed over as-is. */
  encryptionKeySeed: string;
}

/** The one repository checkout the node is told to work in. */
export interface NodeWorkspaceMapping {
  /** The desktop workspace path. Also the sync `projectId`. */
  projectId: string;
  repoUrl: string;
  branch: string;
  checkoutDir: string;
}

export interface NodeProvisionInput {
  deploymentId: string;
  identity: NodeSyncIdentity;
  workspace: NodeWorkspaceMapping;
  credential: NodeCredential;
  /** The Claude Code credentials file, verbatim. */
  claudeCredential: string;
}

/** Everything the container ends up holding, plus where to start from. */
export interface NodeProvisionPlan {
  files: SandboxProvisionRequest["files"];
  allowedHosts: string[];
  configPath: string;
  deviceId: string;
}

const NODE_HOME = "/home/nimbalyst";
const NODE_DIR = `${NODE_HOME}/nimbalyst-node`;
export const NODE_CONFIG_PATH = `${NODE_DIR}/config.json`;
const NODE_CREDENTIAL_PATH = `${NODE_DIR}/node-credential.json`;
const NODE_WORKSPACES_PATH = `${NODE_DIR}/workspaces.json`;
const CLAUDE_CREDENTIAL_PATH = `${NODE_HOME}/.claude/.credentials.json`;

/** Included in the Worker's baseline allowlist, so never worth sending. */
const BASELINE_ALLOWED_HOST = "github.com";

/** The sync device id is derived, not random: a re-provision has to reuse it. */
export function nodeDeviceId(deploymentId: string): string {
  return `sandbox-${deploymentId}`;
}

/**
 * Build the exact file set for the container.
 *
 * Pure on purpose. The interesting failure here — a config the node cannot
 * read, a credential written to the wrong path — is invisible from the desktop
 * and only shows up as a container that quietly does nothing, so it is worth
 * being able to assert on the bytes directly.
 */
export function buildNodeProvisionPlan(input: NodeProvisionInput): NodeProvisionPlan {
  const deviceId = nodeDeviceId(input.deploymentId);

  const config = {
    databasePath: "./nimbalyst.sqlite",
    trust: { mode: "bypass-all" },
    sync: {
      serverUrl: input.identity.serverUrl,
      credentialPath: "./node-credential.json",
      encryptionKeySeed: input.identity.encryptionKeySeed,
      // From the grant, never from local settings. The node's token carries
      // these as `org`/`sub`, and the server rejects the connection outright if
      // the config disagrees with the token.
      personalOrgId: input.credential.orgId,
      personalUserId: input.credential.userId,
      deviceId,
      deviceName: "Cloudflare sandbox",
    },
    workspacesPath: "./workspaces.json",
  };

  const credential = {
    nodeId: input.credential.nodeId,
    userId: input.credential.userId,
    orgId: input.credential.orgId,
    refreshToken: input.credential.refreshToken,
    refreshExpiresAt: input.credential.refreshExpiresAt,
    accessToken: input.credential.accessToken,
    accessTokenExpiresAt: input.credential.accessTokenExpiresAt,
  };

  const workspaces = { workspaces: [{ ...input.workspace }] };

  return {
    deviceId,
    configPath: NODE_CONFIG_PATH,
    // 0600 on all three of the files that carry replayable material. The
    // container runs as one uid today, but a mode that says what the file is
    // costs nothing and survives that changing.
    files: [
      { path: NODE_CONFIG_PATH, content: `${JSON.stringify(config, null, 2)}\n`, mode: 0o600 },
      { path: NODE_CREDENTIAL_PATH, content: `${JSON.stringify(credential, null, 2)}\n`, mode: 0o600 },
      { path: NODE_WORKSPACES_PATH, content: `${JSON.stringify(workspaces, null, 2)}\n` },
      { path: CLAUDE_CREDENTIAL_PATH, content: input.claudeCredential, mode: 0o600 },
    ],
    allowedHosts: extraAllowedHosts(input.workspace.repoUrl),
  };
}

/**
 * Hosts the Worker's baseline does not already cover. Sending `github.com`
 * again would be noise; sending a self-hosted Git host is the whole point.
 */
function extraAllowedHosts(repoUrl: string): string[] {
  const host = hostOf(repoUrl);
  if (!host || host === BASELINE_ALLOWED_HOST) return [];
  return [host];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export interface ProvisionNodeDeps {
  control: SandboxControlClient;
  /** Mint the node's credential. Runs after the local Claude read succeeds. */
  issueCredential: () => Promise<NodeCredential>;
  /** Invalidate the credential from a previous provision, if there was one. */
  revokeCredential: (nodeId: string) => Promise<void>;
  readClaudeCredential: () => Promise<string>;
  previousNodeId?: string | null;
  /**
   * Node ids from earlier runs whose revocation never completed. Retried before
   * anything else, so a credential cannot stay live indefinitely just because
   * the sync server was down once.
   */
  pendingRevocations?: string[];
  /**
   * Persist a node id that still needs revoking. Never given a secret.
   * Returns false when it could not be stored, which the caller must treat as
   * a failure rather than as cleanup completed.
   */
  recordPendingRevocation?: (nodeId: string, reason: string) => boolean;
  clearPendingRevocation?: (nodeId: string) => void;
  /**
   * Called the instant a revoke is confirmed, BEFORE anything else can fail.
   * Must drop the id from the deployment record: a revoked id left there makes
   * the next attempt re-revoke a dead credential, which is a permanent block.
   */
  confirmRevoked?: (nodeId: string) => void;
  /** True when so much cleanup is outstanding that issuing more is reckless. */
  cleanupAtCapacity?: () => boolean;
  now?: () => Date;
  /** Fixed step labels only. Never a message. See errors.ts. */
  logEvent?: (event: string) => void;
}

export interface ProvisionedNode {
  status: SandboxNodeStatus;
  nodeId: string;
  deviceId: string;
  /** ISO-8601. */
  provisionedAt: string;
}

/**
 * Provision and start the node against an already-addressed sandbox.
 *
 * Takes the resolved `SandboxControlTarget` rather than a deployment, so the
 * caller keeps ownership of target validation and this stays testable against a
 * fake control client.
 */
export async function provisionAndStartNode(
  target: SandboxControlTarget,
  input: Omit<NodeProvisionInput, "credential" | "claudeCredential">,
  deps: ProvisionNodeDeps,
): Promise<ProvisionedNode> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logEvent ?? (() => undefined);

  // Step 1. Local, and the likeliest failure.
  const claudeCredential = await deps.readClaudeCredential();

  // Step 2. Every credential this desktop has ever issued and not confirmed
  // revoked has to die before a new one is minted.
  //
  // The earlier version of this logged a failed revoke and carried on. That was
  // wrong: a credential the UI no longer points at is still a live
  // personal-scope credential on the server, and issuing a replacement on top
  // of it means the only way to reach the old one is gone. Revocation is the
  // gate, not a courtesy, so a failure aborts.
  for (const nodeId of revocationQueue(deps)) {
    try {
      await deps.revokeCredential(nodeId);
    } catch {
      log("node-revoke-previous-failed");
      deps.recordPendingRevocation?.(nodeId, "revoke-before-replace-failed");
      throw new SandboxOperationError(
        "grant-failed",
        "node-revoke-previous-failed",
        "Nimbalyst could not revoke the sandbox's previous sync credential, so it did not issue a new one. Try again when the sync server is reachable.",
      );
    }
    // Recorded the moment it is true, and before anything downstream can fail.
    // Deferring this to the end of a successful provision is what made a failed
    // retry permanent: the deployment still named the revoked id, so the next
    // attempt re-revoked a dead credential and refused to issue, forever.
    deps.confirmRevoked?.(nodeId);
    deps.clearPendingRevocation?.(nodeId);
  }

  // Refuse to add to a cleanup backlog that is already too deep. Issuing here
  // would mint yet another credential this desktop may not be able to take
  // back down, and the queue is not allowed to forget entries to make room.
  if (deps.cleanupAtCapacity?.()) {
    log("node-cleanup-at-capacity");
    throw new SandboxOperationError(
      "grant-failed",
      "node-cleanup-at-capacity",
      "Nimbalyst still has sandbox credentials it could not revoke, so it will not issue another one. Reconnect once the sync server is reachable so it can finish cleaning up.",
    );
  }

  const credential = await deps.issueCredential();

  // From here on the credential exists on the server. Anything that fails has
  // to take it back down, or the user is left paying for a live credential that
  // nothing on this desktop knows about.
  try {
    // The grant decides who the node is. If that is not who this desktop thinks
    // it is, the node would join a different user's personal rooms, or more
    // likely be refused with AUTH_MISMATCH and look like a broken sandbox.
    // Which side disagreed is logged; the ids themselves never are.
    if (credential.userId !== input.identity.expectedPersonalUserId) {
      log("node-grant-identity-mismatch-user");
      throw new SandboxOperationError("grant-failed", "node-grant-identity-mismatch-user");
    }
    if (credential.orgId !== input.identity.expectedPersonalOrgId) {
      log("node-grant-identity-mismatch-org");
      throw new SandboxOperationError("grant-failed", "node-grant-identity-mismatch-org");
    }

    const plan = buildNodeProvisionPlan({ ...input, credential, claudeCredential });

    // Step 3. Write, then start. `startNode` is given the same path the plan
    // wrote, rather than a constant re-derived at the call site.
    await deps.control.provision(target, { files: plan.files, allowedHosts: plan.allowedHosts });
    const status = await deps.control.startNode(target, { configPath: plan.configPath });

    if (!status.node.running) {
      // The Worker reported a start that did not take. Naming it as a start
      // failure rather than passing the status back keeps the UI from showing a
      // "connected" node that is not there.
      throw new SandboxOperationError("node-start-failed", "node-start-not-running");
    }

    return {
      status,
      nodeId: credential.nodeId,
      deviceId: plan.deviceId,
      provisionedAt: now().toISOString(),
    };
  } catch (error) {
    await undoCredential(credential.nodeId, deps, log);
    throw error;
  }
}

/** Ids that must be revoked before a replacement is issued, oldest first. */
function revocationQueue(deps: ProvisionNodeDeps): string[] {
  const queue = [...(deps.pendingRevocations ?? [])];
  if (deps.previousNodeId) queue.push(deps.previousNodeId);
  return [...new Set(queue.filter(Boolean))];
}

/**
 * Take back a credential whose provisioning did not complete.
 *
 * If the revoke itself fails, the id is persisted so the next connect revokes
 * it before doing anything else. That record is a node id and a fixed reason,
 * never a token: it is a pointer to something that needs cleaning up, and it
 * has to survive a restart to be worth anything.
 */
async function undoCredential(
  nodeId: string,
  deps: ProvisionNodeDeps,
  log: (event: string) => void,
): Promise<void> {
  try {
    await deps.revokeCredential(nodeId);
    deps.confirmRevoked?.(nodeId);
  } catch {
    log("node-revoke-orphan-failed");
    if (deps.recordPendingRevocation?.(nodeId, "provision-failed") === false) {
      // The id could not even be written down. Nothing else can find this
      // credential now, so say so plainly rather than letting the original
      // failure carry the blame.
      log("node-revoke-orphan-unrecorded");
    }
  }
}

/**
 * Strip anything token-shaped out of the node's own output before it leaves the
 * main process.
 *
 * The node prints its own logs, and a future change on the other side of the
 * container could put a bearer token or a node access token in them. This is a
 * conservative net over the shapes this system actually mints; it is not a
 * general secret scanner, and it is not a reason to log the result.
 */
export function redactNodeLog(log: string): string {
  return log
    .replace(/nimnode(?:rt)?_[A-Za-z0-9._~+/-]+/g, "[redacted]")
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]");
}

// ---------------------------------------------------------------------------
// Workspace mapping
// ---------------------------------------------------------------------------

/**
 * Rewrite a git remote into something the container can clone anonymously over
 * HTTPS.
 *
 * Two conversions, and one removal that matters more than either: any userinfo
 * in an HTTPS remote is stripped. A remote of the form
 * `https://x-access-token:<pat>@github.com/org/repo.git` is common on machines
 * with a credential helper, and copying it into `workspaces.json` would put a
 * real personal access token inside the sandbox — a place the user did not
 * agree to send it.
 */
export function toHttpsRemote(remote: string): string {
  const trimmed = remote.trim();
  if (!trimmed) {
    throw new SandboxOperationError(
      "unknown",
      "workspace-no-remote",
      "This workspace has no `origin` remote, so the sandbox has nothing to clone.",
    );
  }

  // scp-like syntax: git@host:owner/repo.git
  const scpLike = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes("://")) {
    return `https://${scpLike[2]}/${scpLike[3].replace(/^\/+/, "")}`;
  }

  // The scheme is swapped textually, before parsing. `URL.protocol =` silently
  // refuses to move a non-special scheme like `ssh:` to `https:`, so assigning
  // it would leave `ssh://…` in place and ship an unclonable remote.
  const rescheme = trimmed.replace(/^(?:git\+ssh|ssh|git):\/\//i, "https://");

  let parsed: URL;
  try {
    parsed = new URL(rescheme);
  } catch {
    throw new SandboxOperationError(
      "unknown",
      "workspace-remote-unparsable",
      "Nimbalyst could not turn this workspace's `origin` remote into an HTTPS URL for the sandbox.",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SandboxOperationError(
      "unknown",
      "workspace-remote-unsupported-scheme",
      "This workspace's `origin` remote is not something the sandbox can clone over HTTPS.",
    );
  }
  parsed.protocol = "https:";
  parsed.username = "";
  parsed.password = "";
  // ssh:// URLs carry a port that means nothing over HTTPS.
  if (parsed.port === "22") parsed.port = "";
  return parsed.toString().replace(/\/$/, "");
}

/** `/Users/me/sources/stravu-editor` -> `/workspace/stravu-editor`. */
export function checkoutDirFor(workspacePath: string): string {
  const segments = workspacePath.split(/[\\/]+/).filter(Boolean);
  const base = segments[segments.length - 1] ?? "workspace";
  const slug = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "") || "workspace";
  return `/workspace/${slug}`;
}

export interface WorkspaceGitReader {
  remoteUrl(workspacePath: string): Promise<string>;
  branch(workspacePath: string): Promise<string>;
}

/** Resolve the mapping the node clones from a desktop workspace. */
export async function resolveWorkspaceMapping(
  workspacePath: string,
  git: WorkspaceGitReader,
): Promise<NodeWorkspaceMapping> {
  if (!workspacePath || typeof workspacePath !== "string") {
    throw new SandboxOperationError("unknown", "workspace-path-missing");
  }

  let remote: string;
  let branch: string;
  try {
    [remote, branch] = await Promise.all([git.remoteUrl(workspacePath), git.branch(workspacePath)]);
  } catch {
    throw new SandboxOperationError(
      "unknown",
      "workspace-git-unreadable",
      "Nimbalyst could not read this workspace's git remote and branch, so it cannot tell the sandbox what to clone.",
    );
  }

  const trimmedBranch = branch.trim();
  if (!trimmedBranch || trimmedBranch === "HEAD") {
    // A detached HEAD has no branch name to clone, and guessing one would put
    // the sandbox on different code than the user is looking at.
    throw new SandboxOperationError(
      "unknown",
      "workspace-detached-head",
      "This workspace is not on a branch, so the sandbox has no branch to check out. Switch to a branch and try again.",
    );
  }

  return {
    projectId: workspacePath,
    repoUrl: toHttpsRemote(remote),
    branch: trimmedBranch,
    checkoutDir: checkoutDirFor(workspacePath),
  };
}
