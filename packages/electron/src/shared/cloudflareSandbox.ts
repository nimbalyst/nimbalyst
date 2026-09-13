/**
 * Contract between the Cloudflare Sandboxes settings UI and the main-process
 * handlers that shell out to Wrangler.
 *
 * Constraints that shape these types:
 *
 * 1. Authentication is Wrangler's own browser SSO, scoped to a Wrangler profile
 *    (`wrangler auth list` enumerates them; profile-scoped commands run from
 *    a verified profile directory). Nimbalyst never asks for, stores, or renders an API token or
 *    key, so no type here carries one.
 *
 *    The sign-in command depends on WHICH profile, and the two are not
 *    interchangeable. Verified against wrangler 4.125.0's bundled cli.js:
 *      - Named profile: `wrangler auth create <name>` (creates or
 *        re-authenticates).
 *      - The `default` profile: plain `wrangler login`, with NO `--profile`.
 *        `RESERVED_PROFILE_NAMES = ["default", "staging"]`, and both the
 *        `auth create` and `auth activate` handlers call `validateProfileName`,
 *        which throws for either name: "Use the login and logout commands to
 *        manage the default profile." So `auth create default` always fails.
 *      - `whoami` explicitly rejects `--profile`, including `default`.
 *        Run `whoami --json` from the verified profile directory instead.
 *      - The same validator restricts names to /^[a-zA-Z0-9_-]+$/.
 *
 *    None of this changes the request shape: the renderer asks for a profile by
 *    name via `CreateProfileRequest` and the handler picks the command.
 * 2. An account is never chosen implicitly. `CloudflareAccount` carries no
 *    "default" flag on purpose: the renderer requires an explicit selection
 *    even when Wrangler reports exactly one account.
 * 3. A successful deploy is NOT a running container. `SandboxDeployment.status`
 *    describes the Worker deployment; `SandboxDeployment.container` separately
 *    describes whether a container is actually warm. Nothing in the UI may read
 *    one as the other.
 * 4. Every lifecycle operation (wake, stop, delete) binds explicitly to the
 *    deployment it acts on — `deploymentId` + `revision` + `profileName` +
 *    `accountId`. There is no parameterless "current deployment" operation: a
 *    second window holding a stale selection must fail with `deployment-stale`
 *    rather than act on another account's sandbox.
 *
 * 5. The headless node running *inside* the container is a third fact, separate
 *    from both. `SandboxDeployment.node` describes a `nimbalyst-node` process
 *    the desktop provisioned and started; a warm container with no node is
 *    normal (the container sleeps on idle and everything written into it is
 *    discarded, so a node has to be provisioned again afterwards). Nothing may
 *    read a running container as a connected node.
 *
 * Channel names are `cloudflare-sandbox:*`; every handler resolves with
 * `CloudflareSandboxResponse<T>` rather than rejecting, so the panel can
 * render an actionable message instead of an unhandled rejection.
 */

export const CLOUDFLARE_SANDBOX_CHANNELS = {
  getPrerequisites: 'cloudflare-sandbox:get-prerequisites',
  listProfiles: 'cloudflare-sandbox:list-profiles',
  createProfile: 'cloudflare-sandbox:create-profile',
  listAccounts: 'cloudflare-sandbox:list-accounts',
  planDeployment: 'cloudflare-sandbox:plan-deployment',
  deploy: 'cloudflare-sandbox:deploy',
  getDeployment: 'cloudflare-sandbox:get-deployment',
  wake: 'cloudflare-sandbox:wake',
  stop: 'cloudflare-sandbox:stop',
  deleteDeployment: 'cloudflare-sandbox:delete-deployment',
  connectNode: 'cloudflare-sandbox:connect-node',
  nodeStatus: 'cloudflare-sandbox:node-status',
  disconnectNode: 'cloudflare-sandbox:disconnect-node',
  startRemoteSession: 'cloudflare-sandbox:start-remote-session',
} as const;

export type CloudflareSandboxChannel =
  (typeof CLOUDFLARE_SANDBOX_CHANNELS)[keyof typeof CLOUDFLARE_SANDBOX_CHANNELS];

/** Machine-readable failure reasons the UI branches on. */
export type CloudflareSandboxErrorCode =
  | 'wrangler-missing'
  | 'wrangler-unsupported'
  | 'not-authenticated'
  | 'profile-exists'
  // No container-runtime error codes: local Docker is not a dependency.
  | 'login-cancelled'
  | 'account-required'
  | 'plan-stale'
  | 'deploy-failed'
  /** The request named a deployment/revision that is no longer the saved one. */
  | 'deployment-stale'
  /**
   * Cloudflare reports no Worker by the saved name. Only raised internally: a
   * retried delete treats it as "already done" and carries on with the
   * container application, which Wrangler's Worker delete leaves behind.
   */
  | 'worker-missing'
  /** A destructive request arrived without its explicit confirmation. */
  | 'confirmation-required'
  /** The deployment exists but its container could not be reached. */
  | 'container-unavailable'
  /**
   * A node operation was asked for on a container that has no node
   * configuration in it. Expected after the container sleeps: its filesystem is
   * ephemeral, so the answer is to connect the node again, not to retry.
   */
  | 'node-not-provisioned'
  /** The node configuration is in place but the process would not start. */
  | 'node-start-failed'
  /** The device-authorization grant against the sync server did not complete. */
  | 'grant-failed'
  | 'unknown';

export interface CloudflareSandboxError {
  code: CloudflareSandboxErrorCode;
  /** Human-readable, safe to render. Handlers must not include token material. */
  message: string;
}

export type CloudflareSandboxResponse<T> =
  | { success: true; data: T }
  | { success: false; error: CloudflareSandboxError };

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

export interface WranglerPrerequisite {
  installed: boolean;
  /** e.g. "4.125.0". Null when Wrangler is absent or the version is unreadable. */
  version: string | null;
  /** False on Wrangler builds without `auth create` / `auth list`. */
  supportsProfiles: boolean;
}

/**
 * Local setup requires Wrangler only. There is deliberately no local container
 * runtime requirement here: deployment uses a prebuilt registry image.
 */
export interface CloudflareSandboxPrerequisites {
  wrangler: WranglerPrerequisite;
  /** True when local Wrangler prerequisites are satisfied; account/artifact review follows. */
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Profiles and accounts
// ---------------------------------------------------------------------------

export interface WranglerProfile {
  /** Profile name passed to Wrangler as `--profile <name>`. */
  name: string;
  /**
   * Identity Wrangler reports for the profile. `wrangler auth list` does NOT
   * include it — the handler resolves it from `wrangler whoami`, so it stays
   * null when that is unavailable or the session is expired.
   */
  identity: string | null;
  /**
   * False when the profile exists but its session is expired or revoked. Also
   * not available from `auth list`; derived from `whoami --json` in its profile directory.
   */
  authenticated: boolean;
  /** Directories bound to the profile via `wrangler auth activate`. */
  boundDirectories: string[];
}

/** Wrangler rejects these as profile names; `default` is managed by `login`. */
export const RESERVED_WRANGLER_PROFILE_NAMES = ['default', 'staging'] as const;

/** Wrangler's own constraint on profile names, from `validateProfileName`. */
export const WRANGLER_PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface CreateProfileRequest {
  /**
   * Profile name. The handler chooses the command: `wrangler auth create
   * <name>` for a named profile (it both creates and re-authenticates), or
   * plain `wrangler login` for `default`, which `auth create` refuses as a
   * reserved name. See the header comment.
   */
  name: string;
  /**
   * Set when deliberately re-authenticating a profile that already exists.
   * Without it an existing name must fail with `profile-exists`, so a new
   * sign-in cannot silently take over a profile the user already uses.
   */
  reauthenticate?: boolean;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface ListAccountsRequest {
  profileName: string;
}

// ---------------------------------------------------------------------------
// Deployment review
// ---------------------------------------------------------------------------

export interface PlanDeploymentRequest {
  profileName: string;
  accountId: string;
}

export interface PlannedResource {
  /** e.g. "Worker", "Durable Object namespace", "Container image". */
  kind: string;
  name: string;
  /** What happens on deploy, in the user's terms. */
  action: 'create' | 'update' | 'reuse';
}

/** The container shape a deploy will request. Shown verbatim in the review. */
export interface PlannedContainerConfig {
  /** Cloudflare instance type, e.g. "standard-3". */
  instanceType: string;
  /** Concurrency ceiling; 1 for the initial single-sandbox model. */
  maxInstances: number;
  /** Idle minutes before the container sleeps (Cloudflare `sleepAfter`). */
  sleepAfterMinutes: number;
}

export interface DeploymentPlan {
  /** Echoed back on deploy; a mismatch means the plan was rebuilt. */
  planId: string;
  profileName: string;
  account: CloudflareAccount;
  resources: PlannedResource[];
  container: PlannedContainerConfig;
  /**
   * Plain-language billing consequences (paid-plan requirement, per-request or
   * per-GB-hour charges). Rendered verbatim, so the handler owns the wording.
   */
  costNotes: string[];
  /** True when deploying requires a paid Cloudflare plan. */
  requiresPaidPlan: boolean;
}

export interface DeployRequest {
  planId: string;
  profileName: string;
  accountId: string;
}

// ---------------------------------------------------------------------------
// Deployed sandbox
// ---------------------------------------------------------------------------

/** State of the Worker deployment. Says nothing about a running container. */
export type SandboxDeploymentStatus =
  | 'not-deployed'
  | 'deploying'
  | 'deployed'
  | 'error'
  | 'deleting';

/** State of the container itself, observed separately from the deployment. */
export type SandboxContainerStatus =
  | 'unknown'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping';

export interface SandboxContainerState {
  status: SandboxContainerStatus;
  /**
   * ISO-8601 timestamp of the observation. The UI presents container state as
   * of this moment rather than as live truth; null means never observed.
   */
  observedAt: string | null;
  /** Populated when the container is in an error or unreachable state. */
  message: string | null;
}

/**
 * How the sandbox is reached. The initial control path is a private Worker RPC
 * binding, so `url` is legitimately null — that is not a missing value and the
 * UI must not present it as a failure.
 */
export type SandboxAccessKind = 'private-rpc' | 'public-url';

/**
 * The repository checkout the node was told about, echoed back for the UI.
 *
 * Deliberately no `repoUrl`. The remote is needed to provision and to build the
 * egress allowlist, but it is not needed to render this and it is not kept on
 * disk: it can carry a host and an org the user would not expect a settings
 * file to name.
 */
export interface SandboxNodeWorkspace {
  /** The desktop workspace path. Doubles as the sync `projectId`. */
  projectId: string;
  branch: string;
}

/**
 * The `nimbalyst-node` process inside the container.
 *
 * The two halves have different lifetimes and different storage:
 *
 *  - `nodeId`, `deviceId`, `provisionedAt`, `workspace` are what this desktop
 *    provisioned. They are persisted, because `nodeId` is the only way to
 *    revoke the credential and it has to survive a restart.
 *  - `running`, `processId`, `startedAt`, `exitCode`, `recentLog` are a live
 *    observation of the container. They are **never persisted** — a stored
 *    observation is a claim that goes stale the moment the container sleeps,
 *    and `recentLog` is process output that has no business on the user's disk.
 *    Unobserved, they read as a node that is not running, which is what a
 *    sandbox that has slept actually holds.
 */
export interface SandboxNodeState {
  running: boolean;
  processId: string | null;
  /** Epoch milliseconds, as reported by the container. */
  startedAt: number | null;
  exitCode: number | null;
  /** Bounded, redacted tail of the node's own output. Transient. */
  recentLog: string;
  /** Device-grant node id on the sync server; needed to revoke the credential. */
  nodeId: string | null;
  /** Sync device id the node announces itself under, chosen by this desktop. */
  deviceId: string | null;
  /** ISO-8601 of the last successful provision from this desktop. */
  provisionedAt: string | null;
  workspace: SandboxNodeWorkspace | null;
}

export interface SandboxDeployment {
  /** Stable id for this deployment; required by every lifecycle request. */
  deploymentId: string;
  /** Changes whenever the saved deployment record changes; used for staleness. */
  revision: string;
  status: SandboxDeploymentStatus;
  container: SandboxContainerState;
  /**
   * Null when no node has ever been connected from this desktop. A non-null
   * value with `running: false` is the normal state after the container slept.
   */
  node: SandboxNodeState | null;
  profileName: string;
  account: CloudflareAccount;
  access: SandboxAccessKind;
  /** Null for `private-rpc`, which is the expected initial configuration. */
  url: string | null;
  /** ISO-8601. */
  deployedAt: string | null;
  /** Populated only when `status === 'error'`. */
  errorMessage: string | null;
}

/**
 * Binds a lifecycle request to one specific deployment. A handler must reject
 * with `deployment-stale` when any field disagrees with the saved deployment.
 */
export interface SandboxDeploymentTarget {
  deploymentId: string;
  revision: string;
  profileName: string;
  accountId: string;
}

export type WakeRequest = SandboxDeploymentTarget;

export interface StopRequest extends SandboxDeploymentTarget {
  /**
   * Must be true. Stopping the container ends its processes and discards
   * everything written inside it; the renderer sets this only after showing
   * that warning, and the handler rejects a stop without it
   * (`confirmation-required`) rather than inferring consent from the call.
   * Passed through to the Worker so the same consent is visible end to end.
   */
  discardEphemeralData: true;
}

export interface DeleteDeploymentRequest extends SandboxDeploymentTarget {
  /**
   * Must be true. The renderer sets it only after the user confirms against the
   * named account, so a mis-routed request fails with `confirmation-required`
   * instead of deleting another window's sandbox.
   */
  confirmed: true;
}

// ---------------------------------------------------------------------------
// Headless node
// ---------------------------------------------------------------------------

/**
 * Provision and start the node.
 *
 * Deliberately one request rather than a provision step and a start step: the
 * container's filesystem is ephemeral, so a provision that is not immediately
 * followed by a start leaves nothing durable behind and the UI would be
 * offering the user a state that evaporates.
 *
 * `workspacePath` names the desktop workspace whose git remote and branch the
 * node clones. It is passed explicitly — there is no "current workspace" on the
 * main side of this channel.
 */
export interface ConnectNodeRequest extends SandboxDeploymentTarget {
  workspacePath: string;
}

export type NodeStatusRequest = SandboxDeploymentTarget;

export interface DisconnectNodeRequest extends SandboxDeploymentTarget {
  /**
   * Must be true. Disconnecting stops the agent process and discards the
   * container's filesystem, including anything a running session wrote and had
   * not pushed. The renderer sets this only after showing that warning.
   */
  discardEphemeralData: true;
}

/**
 * Ask the connected node to create a session and run a prompt.
 *
 * The request is device-targeted at the node, so no other device — including
 * this desktop — executes it.
 */
export interface StartRemoteSessionRequest extends SandboxDeploymentTarget {
  /** Must match the workspace the node was provisioned with. */
  workspacePath: string;
  prompt: string;
}

export interface StartRemoteSessionResult {
  /** Correlation id of the create-session request that was sent. */
  requestId: string;
  /** Session id the node reported creating. */
  sessionId: string;
}

/** Typed view of the invoke surface; the preload `invoke` itself is untyped. */
export interface CloudflareSandboxApi {
  getPrerequisites(): Promise<CloudflareSandboxResponse<CloudflareSandboxPrerequisites>>;
  listProfiles(): Promise<CloudflareSandboxResponse<WranglerProfile[]>>;
  createProfile(
    request: CreateProfileRequest,
  ): Promise<CloudflareSandboxResponse<WranglerProfile>>;
  listAccounts(
    request: ListAccountsRequest,
  ): Promise<CloudflareSandboxResponse<CloudflareAccount[]>>;
  planDeployment(
    request: PlanDeploymentRequest,
  ): Promise<CloudflareSandboxResponse<DeploymentPlan>>;
  deploy(request: DeployRequest): Promise<CloudflareSandboxResponse<SandboxDeployment>>;
  /** Null data means this installation has no saved deployment. */
  getDeployment(): Promise<CloudflareSandboxResponse<SandboxDeployment | null>>;
  wake(request: WakeRequest): Promise<CloudflareSandboxResponse<SandboxDeployment>>;
  stop(request: StopRequest): Promise<CloudflareSandboxResponse<SandboxDeployment>>;
  deleteDeployment(
    request: DeleteDeploymentRequest,
  ): Promise<CloudflareSandboxResponse<SandboxDeployment | null>>;
  connectNode(request: ConnectNodeRequest): Promise<CloudflareSandboxResponse<SandboxDeployment>>;
  nodeStatus(request: NodeStatusRequest): Promise<CloudflareSandboxResponse<SandboxDeployment>>;
  disconnectNode(
    request: DisconnectNodeRequest,
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>>;
  startRemoteSession(
    request: StartRemoteSessionRequest,
  ): Promise<CloudflareSandboxResponse<StartRemoteSessionResult>>;
}
