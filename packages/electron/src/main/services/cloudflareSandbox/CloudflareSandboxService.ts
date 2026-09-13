/**
 * Orchestrates the Cloudflare sandbox settings flow.
 *
 * Every method returns `CloudflareSandboxResponse<T>` and never rejects, so the
 * settings panel always has something to render.
 *
 * Three invariants are enforced here rather than at the call sites:
 *
 *   1. **One mutation at a time.** Deploy, wake, stop and delete run through a
 *      serial queue. Without it, a deploy to account B could finish after a
 *      delete of account A and write its result over the newer record — the
 *      saved deployment is a single slot, and interleaved writes silently
 *      repoint it at the wrong account.
 *   2. **Revalidate at execution, not at enqueue.** A request that waited behind
 *      another mutation re-checks its target against the saved record before it
 *      acts, because the record it was rendered from may no longer be current.
 *   3. **Save before the remote call, not after.** `wrangler deploy` is not
 *      transactional: it uploads the Worker before provisioning the container.
 *      If the app dies mid-deploy, the identity needed to find and delete that
 *      half-built Worker has to already be on disk.
 */

import { randomUUID } from "crypto";
import simpleGit from "simple-git";
import { asPersonalMemberId, type PersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";

import type {
  CloudflareAccount,
  CloudflareSandboxPrerequisites,
  CloudflareSandboxResponse,
  ConnectNodeRequest,
  CreateProfileRequest,
  DeleteDeploymentRequest,
  DeployRequest,
  DeploymentPlan,
  DisconnectNodeRequest,
  ListAccountsRequest,
  NodeStatusRequest,
  PlanDeploymentRequest,
  SandboxDeployment,
  SandboxDeploymentTarget,
  StartRemoteSessionRequest,
  StartRemoteSessionResult,
  StopRequest,
  WakeRequest,
  WranglerProfile,
} from "../../../shared/cloudflareSandbox";
import {
  PackagedArtifactProvider,
  type SandboxArtifactProvider,
} from "./artifactProvider";
import {
  applicationsForWorker,
  deleteContainerApplication,
  listContainerApplications,
} from "./containerApplications";
import {
  buildPlan,
  PlanRegistry,
  requireAvailableArtifact,
  type PlanInputs,
} from "./deploymentPlan";
import {
  clearDeployment,
  clearDeploymentNode,
  clearPendingRevocation,
  clearRevokedNode,
  getInstallationId,
  readDeployment,
  readNodeId,
  readPendingRevocations,
  readWorkerName,
  pendingRevocationsAtCapacity,
  recordPendingRevocation,
  requireTarget,
  updateDeployment,
  updateDeploymentIfUnchanged,
  updateDeploymentNode,
  writeDeployment,
} from "./deploymentStore";
import { exportClaudeCredential } from "./claudeCredentialExport";
import { DeviceGrantClient, type NodeCredential } from "./deviceGrantClient";
import {
  provisionAndStartNode,
  redactNodeLog,
  resolveWorkspaceMapping,
  type WorkspaceGitReader,
} from "./nodeProvisioner";
import { SandboxOperationError, toSandboxError } from "./errors";
import { getPrerequisites } from "./prerequisites";
import {
  createOrReauthenticateProfile,
  listAccounts,
  listProfiles,
  resolvedProfileDir,
} from "./profiles";
import {
  ChildProcessControlClient,
  type SandboxControlClient,
  type SandboxControlTarget,
  type SandboxNodeStatus,
  toContainerState,
  unreachableContainerState,
} from "./sandboxControl";
import { getEncryptionKeySeed } from "../CredentialService";
import {
  getPersonalOrgId,
  getPersonalSessionJwt,
  getPersonalUserId,
} from "../StytchAuthService";
import { getSyncProvider } from "../SyncManager";
import { getSessionSyncConfig } from "../../utils/store";
import { logger } from "../../utils/logger";
import { resolveWranglerModulePath, runWrangler } from "./wranglerCli";
import { deriveWorkerName, writeControlConfig } from "./workerConfig";
import { isValidProfileName } from "./wranglerPaths";

/**
 * Everything the node operations need from the rest of the app.
 *
 * Behind an interface for two reasons. It keeps sync, auth and credential
 * storage out of this module's own import graph at test time, and it makes the
 * one rule that matters here checkable: `personalJwt` is the PERSONAL Stytch
 * JWT and nothing else. A team JWT has a different `sub` per org, the sync
 * server answers the device-approval endpoint with 403 for one, and the node
 * would end up bound to the wrong subject. See docs/IDENTITY_AUTH_AND_ROOMS.md.
 */
export interface SandboxNodeEnvironment {
  /** HTTPS base of the sync server, matching whatever this build syncs to. */
  syncServerUrl(): string;
  /** Null when personal sync is not configured on this install. */
  personalIdentity(): { personalOrgId: string; personalUserId: PersonalMemberId } | null;
  encryptionKeySeed(): string;
  readClaudeCredential(): Promise<string>;
  /** Run the device grant. Authorized with the personal JWT, never a team one. */
  issueNodeCredential(deviceLabel: string): Promise<NodeCredential>;
  revokeNodeCredential(nodeId: string): Promise<void>;
  git: WorkspaceGitReader;
  /**
   * Send a device-targeted create-session request and wait for the answer.
   * Resolves the session id the target device reported creating.
   */
  requestRemoteSession(request: {
    requestId: string;
    projectId: string;
    prompt: string;
    targetDeviceId: string;
  }): Promise<string>;
}

export interface CloudflareSandboxServiceDeps {
  artifacts?: SandboxArtifactProvider;
  control?: SandboxControlClient;
  node?: SandboxNodeEnvironment;
  now?: () => Date;
}

export class CloudflareSandboxService {
  #artifacts: SandboxArtifactProvider;
  #control: SandboxControlClient;
  #node: SandboxNodeEnvironment;
  #now: () => Date;
  #plans = new PlanRegistry();
  /** Serialises every mutating operation. See invariant 1. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: CloudflareSandboxServiceDeps = {}) {
    this.#artifacts = deps.artifacts ?? new PackagedArtifactProvider();
    this.#control = deps.control ?? new ChildProcessControlClient();
    this.#node = deps.node ?? createDefaultNodeEnvironment();
    this.#now = deps.now ?? (() => new Date());
  }

  async getPrerequisites(): Promise<
    CloudflareSandboxResponse<CloudflareSandboxPrerequisites>
  > {
    return this.#guard(() => getPrerequisites());
  }

  async listProfiles(): Promise<CloudflareSandboxResponse<WranglerProfile[]>> {
    return this.#guard(() => listProfiles());
  }

  async createProfile(
    request: CreateProfileRequest
  ): Promise<CloudflareSandboxResponse<WranglerProfile>> {
    return this.#guard(async () => {
      if (!isValidProfileName(request?.name)) {
        throw new SandboxOperationError("unknown", "create-profile-bad-name");
      }
      return createOrReauthenticateProfile(
        request.name,
        request.reauthenticate === true
      );
    });
  }

  async listAccounts(
    request: ListAccountsRequest
  ): Promise<CloudflareSandboxResponse<CloudflareAccount[]>> {
    return this.#guard(async () => {
      if (!isValidProfileName(request?.profileName)) {
        throw new SandboxOperationError("unknown", "list-accounts-bad-profile");
      }
      return listAccounts(request.profileName);
    });
  }

  async planDeployment(
    request: PlanDeploymentRequest
  ): Promise<CloudflareSandboxResponse<DeploymentPlan>> {
    return this.#guard(async () => {
      const { profileName, accountId } =
        this.#requireProfileAndAccount(request);
      return this.#plans.remember(
        buildPlan(await this.#planInputs(profileName, accountId))
      );
    });
  }

  async deploy(
    request: DeployRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        const { profileName, accountId } =
          this.#requireProfileAndAccount(request);
        if (typeof request.planId !== "string" || !request.planId) {
          throw new SandboxOperationError(
            "plan-stale",
            "deploy-without-plan-id"
          );
        }

        // Recomputed here, after any queued mutation has finished, so a plan
        // approved before an intervening delete cannot be replayed.
        const inputs = await this.#planInputs(profileName, accountId);
        this.#plans.requireCurrent(
          request.planId,
          { profileName, accountId },
          inputs
        );

        const existing = readDeployment();
        if (existing && existing.account.id !== accountId) {
          // Any saved record for another account blocks, whatever its status.
          // `error`, `deploying` and `deleting` are exactly the states that can
          // be holding half-created, billable resources, and there is one saved
          // slot: overwriting it loses the only pointer to them. Clearing that
          // record is the user's decision, made through delete.
          throw new SandboxOperationError(
            "deployment-stale",
            "deploy-would-orphan-existing",
            "A sandbox for a different Cloudflare account is already recorded, and it may still have resources in that account. Delete it first so nothing is left behind."
          );
        }

        const artifact = await this.#artifacts.prepare({
          accountId,
          accountName: inputs.account.name,
          profileName,
          workerName: inputs.workerName,
        });

        // `describe()` and `prepare()` read the artifact directory at different
        // moments. If it was swapped in between, what is about to be deployed is
        // not what the user approved, so compare before anything is written or
        // sent. This runs before the saved record and before Wrangler.
        if (
          artifact.contentHash !== inputs.contentHash ||
          artifact.imageRef !== inputs.imageRef ||
          artifact.workerName !== inputs.workerName ||
          artifact.container.instanceType !== inputs.container.instanceType ||
          artifact.container.maxInstances !== inputs.container.maxInstances ||
          artifact.container.sleepAfterMinutes !==
            inputs.container.sleepAfterMinutes
        ) {
          throw new SandboxOperationError(
            "plan-stale",
            "artifact-changed-after-review",
            "The sandbox files changed while this deployment was being prepared, so nothing was deployed. Review the plan again."
          );
        }

        // Invariant 3: the identity lands on disk before the Worker exists.
        const inFlight = writeDeployment({
          profileName,
          accountId,
          accountName: inputs.account.name,
          workerName: artifact.workerName,
          status: "deploying",
          deployedAt: null,
        });

        try {
          await runWrangler(
            [
              "deploy",
              "--containers-rollout",
              "immediate",
              "--config",
              artifact.configPath,
              "--profile",
              profileName,
            ],
            { cwd: artifact.projectDir, timeoutMs: 10 * 60_000 }
          );
        } catch (error) {
          writeDeployment({
            deploymentId: inFlight.deploymentId,
            profileName,
            accountId,
            accountName: inputs.account.name,
            workerName: artifact.workerName,
            status: "error",
            deployedAt: null,
            errorMessage:
              error instanceof SandboxOperationError
                ? error.message
                : "Wrangler could not finish the deployment.",
          });
          throw error;
        }

        this.#plans.forget(request.planId);
        return writeDeployment({
          deploymentId: inFlight.deploymentId,
          profileName,
          accountId,
          accountName: inputs.account.name,
          workerName: artifact.workerName,
          status: "deployed",
          deployedAt: this.#now().toISOString(),
        });
      })
    );
  }

  /**
   * The saved record plus a fresh container observation.
   *
   * Reading the cache alone would make the panel's Refresh button a no-op. A
   * failed observation is recorded as an unknown container state and the
   * deployment status is left exactly as it was, because an unreachable
   * container says nothing about whether the Worker deployed.
   */
  async getDeployment(): Promise<
    CloudflareSandboxResponse<SandboxDeployment | null>
  > {
    return this.#guard(() =>
      this.#serial(async () => {
        const saved = readDeployment();
        if (!saved || saved.status !== "deployed") return saved;

        let container;
        try {
          const target = await this.#controlTarget(saved);
          container = toContainerState(
            await this.#control.status(target),
            this.#now
          );
        } catch (error) {
          container = unreachableContainerState(safeMessage(error), this.#now);
        }

        // The observation took time. Write it only if the record is still the
        // one we observed: a delete or a redeploy that landed meanwhile owns
        // the slot now, and stamping a stale container state onto it would
        // describe a container belonging to a different deployment.
        const updated =
          updateDeploymentIfUnchanged(saved.revision, { container }) ??
          readDeployment();

        // Reading node state costs a second RPC, and asking a sleeping sandbox
        // for it would wake the container, turning a passive refresh into a
        // billable start the user did not ask for. So this is skipped unless
        // the container is already up.
        //
        // Skipping is safe precisely because observations are not persisted: a
        // stopped container yields the default "not running" node, so the panel
        // offers Connect again instead of showing a node that cannot exist.
        if (!updated?.node || container.status !== "running") return updated;
        return this.#observeNode(updated);
      })
    );
  }

  async wake(
    request: WakeRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        const saved = requireTarget(request);
        const target = await this.#controlTarget(saved);
        return this.#observe(() => this.#control.wake(target));
      })
    );
  }

  async stop(
    request: StopRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        // Consent is carried explicitly from the renderer's two-step confirm and
        // passed through to the Worker, rather than re-inferred here.
        if (request?.discardEphemeralData !== true) {
          throw new SandboxOperationError(
            "confirmation-required",
            "stop-without-consent"
          );
        }
        const saved = requireTarget(request);
        const target = await this.#controlTarget(saved);
        return this.#observe(() =>
          this.#control.stop(target, { discardEphemeralData: true })
        );
      })
    );
  }

  async deleteDeployment(
    request: DeleteDeploymentRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment | null>> {
    return this.#guard(() =>
      this.#serial(async () => {
        if (request?.confirmed !== true) {
          throw new SandboxOperationError(
            "confirmation-required",
            "delete-without-confirmation"
          );
        }
        const saved = requireTarget(request);

        // See deleteWorker for why the generated config carries the account.
        const configPath = await writeControlConfig({
          workerName: this.#workerName(saved),
          accountId: saved.account.id,
        });
        const cwd = await resolvedProfileDir(saved.profileName);

        const workerName = this.#workerName(saved);
        const scope = { configPath, profileName: saved.profileName, cwd };

        updateDeployment({ status: "deleting" });
        try {
          await deleteWorker(workerName, scope);
          // The Worker delete leaves the container application behind. Remove
          // every application named for this Worker, then look again: the
          // record is cleared only once the account shows none, because the
          // record is the only pointer the UI has to what is still billing.
          for (const app of applicationsForWorker(
            await listContainerApplications(scope),
            workerName
          )) {
            await deleteContainerApplication(app.id, scope);
          }
          const remaining = applicationsForWorker(
            await listContainerApplications(scope),
            workerName
          );
          if (remaining.length > 0) {
            throw new SandboxOperationError(
              "unknown",
              "container-application-remains"
            );
          }
          // The node's credential outlives the container it ran in, so a
          // deleted sandbox has to take it with it. Best-effort: the Worker and
          // container are already gone at this point, and refusing to clear the
          // record over an unreachable sync server would strand the user with a
          // deployment that no longer exists anywhere.
          // The node's credential outlives the Worker and the container, so a
          // deleted sandbox has to take it with it. If it cannot be revoked
          // now, the id has to be written to the cleanup queue BEFORE the
          // deployment record goes: the record is the only other place it
          // exists, and clearing first would destroy the last pointer to a live
          // credential. If even that write fails, the record stays.
          const nodeId = saved.node?.nodeId ?? null;
          if (nodeId) {
            try {
              await this.#node.revokeNodeCredential(nodeId);
            } catch {
              logger.main.warn("[CloudflareSandbox:node] delete-revoke-failed");
              if (!recordPendingRevocation(nodeId)) {
                logger.main.warn("[CloudflareSandbox:node] delete-revoke-unrecorded");
                updateDeployment({
                  status: "error",
                  errorMessage:
                    "The sandbox was removed from Cloudflare, but Nimbalyst could not revoke the agent node's sync credential and could not record it for cleanup. This sandbox is kept listed so you can retry.",
                });
                throw new SandboxOperationError("grant-failed", "delete-revoke-unrecorded");
              }
            }
          }
        } catch (error) {
          // Keep the record. A failed delete that erased its own record would
          // strand a live Worker or container with nothing in the UI pointing
          // at it.
          updateDeployment({
            status: "error",
            errorMessage:
              "Nimbalyst could not confirm deletion. This sandbox may still exist in your Cloudflare account.",
          });
          throw error;
        }

        clearDeployment();
        return null;
      })
    );
  }

  // -- headless node -------------------------------------------------------

  /**
   * Provision the sandbox as a headless Nimbalyst device and start it.
   *
   * Runs on the same serial queue as every other mutation: this writes the
   * saved record, and a deploy or delete finishing underneath it would leave
   * a node record pointing at a sandbox that no longer exists.
   */
  async connectNode(
    request: ConnectNodeRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        const saved = requireTarget(request);
        if (saved.status !== "deployed") {
          throw new SandboxOperationError("deployment-stale", "connect-node-not-deployed");
        }
        if (typeof request.workspacePath !== "string" || !request.workspacePath) {
          throw new SandboxOperationError("unknown", "connect-node-no-workspace");
        }

        const identity = this.#node.personalIdentity();
        if (!identity) {
          throw new SandboxOperationError(
            "not-authenticated",
            "connect-node-no-personal-identity",
            "Session sync is not set up on this device, so the sandbox has no identity to join as. Sign in and enable sync first."
          );
        }

        // Checked before anything is woken, provisioned or minted. A dev build
        // pointed at `http://localhost:8790` resolves that INSIDE the
        // container, where it is the container's own loopback, not this
        // machine's sync server. The node would come up, fail to reach
        // anything, and look like a silent hang.
        const syncServerUrl = this.#node.syncServerUrl();
        if (!isReachableSyncServer(syncServerUrl)) {
          throw new SandboxOperationError(
            "grant-failed",
            "connect-node-local-sync-server",
            "The sandbox node needs the production sync server. This build is configured for a local one, which the sandbox cannot reach from inside Cloudflare."
          );
        }

        const workspace = await resolveWorkspaceMapping(request.workspacePath, this.#node.git);
        const target = await this.#controlTarget(saved);

        // The container has to be up before anything can be written into it.
        // Waking here is explicit rather than a side effect of the first RPC,
        // and the observation is recorded so the card is not left claiming the
        // sandbox is stopped while a node runs in it.
        updateDeployment({
          container: toContainerState(await this.#control.wake(target), this.#now),
        });

        const provisioned = await provisionAndStartNode(
          target,
          {
            deploymentId: saved.deploymentId,
            identity: {
              serverUrl: syncServerUrl,
              expectedPersonalOrgId: identity.personalOrgId,
              expectedPersonalUserId: identity.personalUserId,
              encryptionKeySeed: this.#node.encryptionKeySeed(),
            },
            workspace,
          },
          {
            control: this.#control,
            issueCredential: () => this.#node.issueNodeCredential("Cloudflare sandbox"),
            revokeCredential: (nodeId) => this.#node.revokeNodeCredential(nodeId),
            readClaudeCredential: () => this.#node.readClaudeCredential(),
            previousNodeId: readNodeId(),
            pendingRevocations: readPendingRevocations(),
            recordPendingRevocation: (nodeId) => recordPendingRevocation(nodeId),
            clearPendingRevocation: (nodeId) => clearPendingRevocation(nodeId),
            confirmRevoked: (nodeId) => clearRevokedNode(nodeId),
            cleanupAtCapacity: () => pendingRevocationsAtCapacity(),
            now: this.#now,
            logEvent: (event) => logger.main.warn(`[CloudflareSandbox:node] ${event}`),
          }
        );

        logger.main.info(
          `[CloudflareSandbox:node] connected device=${provisioned.deviceId} branch=${workspace.branch}`
        );
        // Identity is persisted; the observation rides back on the response
        // only. See PersistedNodeRecord.
        const stored = updateDeploymentNode({
          nodeId: provisioned.nodeId,
          deviceId: provisioned.deviceId,
          provisionedAt: provisioned.provisionedAt,
          workspace: { projectId: workspace.projectId, branch: workspace.branch },
        });
        return withObservation(stored, provisioned.status);
      })
    );
  }

  /** Observe the node without waking anything. */
  async nodeStatus(
    request: NodeStatusRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        const saved = requireTarget(request);
        if (!saved.node) {
          throw new SandboxOperationError("node-not-provisioned", "node-status-without-node");
        }
        return this.#observeNode(saved);
      })
    );
  }

  /**
   * Stop the node and invalidate its credential.
   *
   * Three things have to be true before the record can go, and each is checked
   * rather than assumed:
   *
   *  1. **The process is actually gone.** `stopNode` returns a still-running
   *     node when SIGTERM has not completed, and treating that as success would
   *     revoke the credential out from under a live agent mid-turn and then
   *     hide it from the UI. A node still running is reported as such and the
   *     record is kept, so the user can try again.
   *  2. **The credential is revoked.** It lives on the server and outlives the
   *     container, so stopping the process does not invalidate it.
   *  3. Only then is the record cleared. If the revoke fails the record is kept,
   *     node id and all, so a retry finishes the job. Clearing it would leave a
   *     live credential with nothing pointing at it.
   */
  async disconnectNode(
    request: DisconnectNodeRequest
  ): Promise<CloudflareSandboxResponse<SandboxDeployment>> {
    return this.#guard(() =>
      this.#serial(async () => {
        if (request?.discardEphemeralData !== true) {
          throw new SandboxOperationError("confirmation-required", "disconnect-node-without-consent");
        }
        const saved = requireTarget(request);
        if (!saved.node) {
          throw new SandboxOperationError("node-not-provisioned", "disconnect-without-node");
        }

        const target = await this.#controlTarget(saved);
        const status = await this.#control.stopNode(target, { discardEphemeralData: true });

        if (status.node.running) {
          logger.main.info("[CloudflareSandbox:node] disconnect-still-running");
          throw new SandboxOperationError(
            "unknown",
            "disconnect-node-still-running",
            "The sandbox agent has been asked to stop but is still shutting down. Its credential was left in place. Check the node again in a moment, and disconnect again if it is still running."
          );
        }

        const nodeId = saved.node.nodeId;
        if (nodeId) await this.#node.revokeNodeCredential(nodeId);

        logger.main.info("[CloudflareSandbox:node] disconnected");
        return clearDeploymentNode();
      })
    );
  }

  /**
   * Ask the connected node to create a session and run a prompt.
   *
   * Not queued: it mutates nothing locally, and it waits on a round trip to
   * another machine — holding the mutation queue for that would block the
   * panel's own refresh behind a remote agent.
   */
  async startRemoteSession(
    request: StartRemoteSessionRequest
  ): Promise<CloudflareSandboxResponse<StartRemoteSessionResult>> {
    return this.#guard(async () => {
      const saved = requireTarget(request);
      const deviceId = saved.node?.deviceId ?? null;
      if (!saved.node || !deviceId) {
        throw new SandboxOperationError("node-not-provisioned", "remote-session-without-node");
      }
      const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
      if (!prompt) {
        throw new SandboxOperationError(
          "unknown",
          "remote-session-empty-prompt",
          "Type what the sandbox agent should do before starting a session."
        );
      }
      // The node clones exactly one workspace. Sending a different projectId
      // would be a request it can only answer with a failure.
      if (saved.node.workspace && saved.node.workspace.projectId !== request.workspacePath) {
        throw new SandboxOperationError(
          "unknown",
          "remote-session-wrong-workspace",
          "This sandbox node was connected for a different workspace. Connect the node again from the workspace you want it to work in."
        );
      }

      const requestId = randomUUID();
      logger.main.info(
        `[CloudflareSandbox:node] remote session requested request=${requestId} device=${deviceId}`
      );
      const sessionId = await this.#node.requestRemoteSession({
        requestId,
        projectId: request.workspacePath,
        prompt,
        targetDeviceId: deviceId,
      });
      logger.main.info(
        `[CloudflareSandbox:node] remote session created request=${requestId} session=${sessionId}`
      );
      return { requestId, sessionId };
    });
  }

  /**
   * Attach a live node observation to the record on its way out.
   *
   * Nothing is written. The saved record holds identity only, so an observation
   * that went stale between two calls cannot outlive the call that made it, and
   * an unobserved node reads as not running rather than as whatever it was
   * doing last time anyone looked.
   */
  async #observeNode(saved: SandboxDeployment): Promise<SandboxDeployment> {
    try {
      const target = await this.#controlTarget(saved);
      return withObservation(saved, await this.#control.nodeStatus(target));
    } catch (error) {
      if (
        error instanceof SandboxOperationError &&
        error.sandboxErrorCode === "node-not-provisioned"
      ) {
        // The container slept and took the node's files with it. That is the
        // expected end state, not an error worth surfacing, and the default
        // observation already says "not running".
        return saved;
      }
      throw error;
    }
  }

  // -- internals ----------------------------------------------------------

  /** Run `operation` after every previously queued mutation has settled. */
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    // Swallow rejection on the chain itself so one failure does not poison
    // every later operation; the caller still sees the real rejection.
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #observe(
    call: () => Promise<Awaited<ReturnType<SandboxControlClient["status"]>>>
  ): Promise<SandboxDeployment> {
    try {
      return updateDeployment({
        container: toContainerState(await call(), this.#now),
      });
    } catch (error) {
      updateDeployment({
        container: unreachableContainerState(safeMessage(error), this.#now),
      });
      throw error;
    }
  }

  async #controlTarget(
    saved: SandboxDeployment
  ): Promise<SandboxControlTarget> {
    const workerName = this.#workerName(saved);
    const [cwd, configPath, helper, wranglerModulePath] = await Promise.all([
      resolvedProfileDir(saved.profileName),
      writeControlConfig({ workerName, accountId: saved.account.id }),
      this.#artifacts.helper(),
      resolveWranglerModulePath(),
    ]);
    return {
      cwd,
      configPath,
      helperPath: helper.helperPath,
      wranglerModulePath,
    };
  }

  /**
   * The persisted Worker name, not a freshly derived one. A record written by
   * an earlier install could carry a different name, and addressing the wrong
   * name on a delete would leave the real Worker running.
   */
  #workerName(saved: SandboxDeployment): string {
    const name = readWorkerName();
    if (!name) {
      throw new SandboxOperationError(
        "deployment-stale",
        "worker-name-missing"
      );
    }
    void saved;
    return name;
  }

  async #planInputs(
    profileName: string,
    accountId: string
  ): Promise<PlanInputs> {
    const accounts = await listAccounts(profileName);
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      throw new SandboxOperationError(
        "account-required",
        "account-not-reachable"
      );
    }

    const artifact = requireAvailableArtifact(await this.#artifacts.describe());
    const saved = readDeployment();
    const workerName = deriveWorkerName(getInstallationId());

    return {
      profileName,
      account,
      workerName,
      imageRef: artifact.imageRef,
      container: artifact.container,
      contentHash: artifact.contentHash,
      workerExists:
        saved?.account.id === accountId && saved.status === "deployed",
    };
  }

  #requireProfileAndAccount(request: {
    profileName?: unknown;
    accountId?: unknown;
  }): { profileName: string; accountId: string } {
    if (!isValidProfileName(request?.profileName)) {
      throw new SandboxOperationError("unknown", "request-bad-profile");
    }
    if (typeof request.accountId !== "string" || !request.accountId) {
      throw new SandboxOperationError("account-required", "request-no-account");
    }
    return { profileName: request.profileName, accountId: request.accountId };
  }

  async #guard<T>(
    operation: () => Promise<T> | T
  ): Promise<CloudflareSandboxResponse<T>> {
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      return { success: false, error: toSandboxError(error) };
    }
  }
}

/**
 * Delete the Worker through a generated config carrying the saved account, not
 * a bare `--name`: that would let Wrangler pick an account implicitly and
 * delete a same-named Worker somewhere the user never chose.
 *
 * A Worker that is already gone counts as deleted. That is the retry case: an
 * earlier attempt removed the Worker and then failed on the container
 * application, and the user is trying again to finish the job.
 */
async function deleteWorker(
  workerName: string,
  scope: { configPath: string; profileName: string; cwd: string }
): Promise<void> {
  try {
    await runWrangler(
      [
        "delete",
        "--name",
        workerName,
        "--config",
        scope.configPath,
        "--profile",
        scope.profileName,
        "--force",
      ],
      { cwd: scope.cwd, timeoutMs: 5 * 60_000 }
    );
  } catch (error) {
    if (
      error instanceof SandboxOperationError &&
      error.sandboxErrorCode === "worker-missing"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Attach a live observation to a saved record for the trip out over IPC.
 *
 * Returns a copy. Nothing here is persisted, and `recentLog` is redacted on the
 * way through: it is process output from another machine, and a future change
 * on that side could put a bearer token in it.
 */
function withObservation(
  deployment: SandboxDeployment,
  status: SandboxNodeStatus
): SandboxDeployment {
  if (!deployment.node) return deployment;
  return {
    ...deployment,
    node: {
      ...deployment.node,
      running: status.node.running,
      processId: status.node.processId,
      startedAt: status.node.startedAt,
      exitCode: status.node.exitCode,
      recentLog: redactNodeLog(status.node.recentLog),
    },
  };
}

/**
 * Whether the sandbox could reach this sync server from inside Cloudflare.
 *
 * Loopback and private hosts resolve to the container itself, so a node
 * configured with one is not misconfigured in a way it can report — it just
 * never connects.
 */
function isReachableSyncServer(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "0.0.0.0";
}

/** A node that never answers is a failure, not a session that is still starting. */
const REMOTE_SESSION_TIMEOUT_MS = 90_000;

/**
 * Wiring to the running app.
 *
 * Built here rather than imported at each call site so that the sync, auth and
 * credential modules stay behind one seam. Note `getPersonalSessionJwt`: this is
 * the only JWT any of this may use.
 */
export function createDefaultNodeEnvironment(): SandboxNodeEnvironment {
  const grant = () =>
    new DeviceGrantClient({
      serverUrl: environment.syncServerUrl(),
      // `getPersonalSessionJwt`, never `getSessionJwt`. Read through a thunk so
      // a poll that outlives one refresh cycle picks up the newer token.
      personalJwt: () => getPersonalSessionJwt(),
      fetch: globalThis.fetch,
    });

  const environment: SandboxNodeEnvironment = {
    syncServerUrl() {
      // Mirrors SyncManager's own derivation. Production builds always talk to
      // production regardless of what a stale config says.
      const config = getSessionSyncConfig();
      const isDevelopmentBuild = process.env.NODE_ENV !== "production";
      const environment = isDevelopmentBuild ? config?.environment : undefined;
      return environment === "development"
        ? "http://localhost:8790"
        : "https://sync.nimbalyst.com";
    },

    personalIdentity() {
      const config = getSessionSyncConfig();
      const personalOrgId = config?.personalOrgId || getPersonalOrgId();
      const personalUserId = config?.personalUserId
        ? asPersonalMemberId(config.personalUserId) // Restore the persisted personal-sync identity's brand.
        : getPersonalUserId();
      if (!personalOrgId || !personalUserId) return null;
      return { personalOrgId, personalUserId };
    },

    encryptionKeySeed: () => getEncryptionKeySeed(),

    readClaudeCredential: () => exportClaudeCredential(),

    issueNodeCredential: (deviceLabel) => grant().run(deviceLabel),

    revokeNodeCredential: (nodeId) => grant().revoke(nodeId),

    git: {
      remoteUrl: (workspacePath) => simpleGit(workspacePath).raw(["remote", "get-url", "origin"]),
      branch: (workspacePath) => simpleGit(workspacePath).revparse(["--abbrev-ref", "HEAD"]),
    },

    async requestRemoteSession({ requestId, projectId, prompt, targetDeviceId }) {
      const provider = getSyncProvider();
      if (!provider?.sendCreateSessionRequest || !provider.onCreateSessionResponse) {
        throw new SandboxOperationError(
          "unknown",
          "remote-session-no-sync",
          "Session sync is not running on this device, so there is no way to reach the sandbox node. Turn sync on and try again."
        );
      }

      return new Promise<string>((resolve, reject) => {
        let settled = false;
        // Subscribed before the send: the node can answer faster than this
        // function returns from `sendCreateSessionRequest`, and a response that
        // arrives first would otherwise be dropped and read as a timeout.
        const unsubscribe = provider.onCreateSessionResponse!((response) => {
          if (settled || response.requestId !== requestId) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          if (response.success && response.sessionId) resolve(response.sessionId);
          else {
            reject(
              new SandboxOperationError(
                "unknown",
                "remote-session-rejected",
                "The sandbox node could not start that session. Check its recent output."
              )
            );
          }
        });

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          // `sendCreateSessionRequest` resolves even when it could not send, so
          // a timeout is the only signal that covers both "never delivered" and
          // "delivered but never answered".
          reject(
            new SandboxOperationError(
              "unknown",
              "remote-session-timeout",
              "The sandbox node did not answer. It may still be starting, or it may have lost its sync connection."
            )
          );
        }, REMOTE_SESSION_TIMEOUT_MS);

        void provider.sendCreateSessionRequest!({
          requestId,
          projectId,
          initialPrompt: prompt,
          provider: "claude-code",
          sessionType: "session",
          targetDeviceId,
          timestamp: Date.now(),
        }).catch(() => {
          // Swallowed on purpose: the provider already logs, and the timeout
          // above owns the failure path so both delivery failures look alike.
        });
      });
    },
  };

  return environment;
}

/** Only curated text; never an exception message, which can carry a token. */
function safeMessage(error: unknown): string {
  return error instanceof SandboxOperationError
    ? error.message
    : "The sandbox container could not be reached.";
}

let singleton: CloudflareSandboxService | null = null;

export function getCloudflareSandboxService(): CloudflareSandboxService {
  if (!singleton) singleton = new CloudflareSandboxService();
  return singleton;
}

/** Test-only. */
export function __setCloudflareSandboxService(
  next: CloudflareSandboxService | null
): void {
  singleton = next;
}
