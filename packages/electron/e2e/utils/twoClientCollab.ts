import type { ElectronApplication, Page } from "@playwright/test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as Y from "yjs";
import {
  createTempWorkspace,
  dismissProjectTrustToast,
  launchElectronApp,
} from "../helpers";
import { startWrangler, stopWrangler } from "./wranglerHelpers";

export type CollabClientLabel = "A" | "B";

export interface TwoClientCollabClient {
  app: ElectronApplication;
  page: Page;
  userId: string;
  workspace: string;
  userDataDir: string;
}

export interface TwoClientExtensionFixture {
  id: string;
  path: string;
}

export interface TwoClientWorkspaceFile {
  relativePath: string;
  content: string | Uint8Array;
  client?: CollabClientLabel | "both";
}

export interface TwoClientCollabHarnessOptions {
  port?: number;
  extensions?: TwoClientExtensionFixture[];
  files?: TwoClientWorkspaceFile[];
  /**
   * Which Electron clients to launch. Defaults to both.
   *
   * The cross-host spec pairs one Electron client with a browser one, and a
   * second Electron instance there is a whole extra app launch that proves
   * nothing.
   */
  clients?: readonly CollabClientLabel[];
}

const DEFAULT_PORT = 8797;

export class TwoClientCollabHarness {
  readonly runId = `${process.pid}-${Date.now()}`;
  readonly orgId = `e2e-two-client-org-${this.runId}`;
  readonly port: number;
  readonly serverUrl: string;
  readonly videoDir: string;
  readonly extensionDir: string;
  readonly users: Record<CollabClientLabel, string> = {
    A: "e2e-two-client-user-a",
    B: "e2e-two-client-user-b",
  };

  /** The Electron clients this run launches. */
  readonly launchedClients: readonly CollabClientLabel[];

  private readonly options: TwoClientCollabHarnessOptions;
  private readonly clients = new Map<
    CollabClientLabel,
    TwoClientCollabClient
  >();
  private readonly workspaces = new Map<CollabClientLabel, string>();
  private readonly userDataDirs = new Map<CollabClientLabel, string>();
  private readonly ownedExtensionLinks: string[] = [];
  private serverRunning = false;

  constructor(options: TwoClientCollabHarnessOptions = {}) {
    this.options = options;
    this.launchedClients = options.clients ?? ["A", "B"];
    this.port = options.port ?? DEFAULT_PORT;
    this.serverUrl = `ws://127.0.0.1:${this.port}`;
    this.extensionDir = path.join(
      os.tmpdir(),
      `nimbalyst-two-client-extensions-${this.runId}`
    );
    this.videoDir = path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "e2e_test_output",
      "videos",
      `collab-${this.runId}`
    );
  }

  get clientA(): TwoClientCollabClient {
    return this.getClient("A");
  }

  get clientB(): TwoClientCollabClient {
    return this.getClient("B");
  }

  async start(): Promise<void> {
    await this.installExtensionFixtures();
    await fs.mkdir(this.videoDir, { recursive: true });

    for (const label of this.launchedClients) {
      const workspace = await createTempWorkspace();
      const userDataDir = path.join(
        os.tmpdir(),
        `nimbalyst-two-client-${label.toLowerCase()}-${this.runId}`
      );
      this.workspaces.set(label, workspace);
      this.userDataDirs.set(label, userDataDir);
    }
    await this.writeWorkspaceFixtures();
    await this.startServer();
    await this.makeOrgServerManaged();
    for (const label of this.launchedClients) {
      await this.launchClient(label, false);
    }
  }

  async stop(): Promise<void> {
    for (const label of this.launchedClients) {
      await this.closeClient(label);
    }
    if (this.serverRunning) {
      await stopWrangler();
      this.serverRunning = false;
    }
    for (const dir of [
      ...this.workspaces.values(),
      ...this.userDataDirs.values(),
    ]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const link of this.ownedExtensionLinks) {
      await fs
        .rm(link, { recursive: true, force: true })
        .catch(() => undefined);
    }
    await fs
      .rm(this.extensionDir, { recursive: true, force: true })
      .catch(() => undefined);
  }

  async startServer(): Promise<void> {
    if (this.serverRunning) return;
    await startWrangler(this.port);
    this.serverRunning = true;
  }

  async stopServer(): Promise<void> {
    if (!this.serverRunning) return;
    await stopWrangler();
    this.serverRunning = false;
  }

  async restartClient(
    label: CollabClientLabel
  ): Promise<TwoClientCollabClient> {
    await this.closeClient(label);
    return this.launchClient(label, true);
  }

  async closeClient(label: CollabClientLabel): Promise<void> {
    const client = this.clients.get(label);
    this.clients.delete(label);
    await client?.app.close().catch(() => undefined);
  }

  async openSharedMode(label: CollabClientLabel): Promise<Page> {
    const page = this.getClient(label).page;
    const modeButton = page.getByTestId("collab-mode-button");
    if ((await modeButton.getAttribute("aria-pressed")) !== "true") {
      await modeButton.click();
    }
    const sidebar = page.getByTestId("collab-sidebar");
    if (!(await sidebar.isVisible())) {
      await page.getByTitle("Show Shared documents sidebar").click();
    }
    await sidebar.waitFor({ state: "visible", timeout: 15_000 });
    await page
      .getByText("Team synced", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    return page;
  }

  /**
   * Wrangler's dev auth bypass query for a client. The main-process test
   * identity bridge hands this to the renderer for documents opened through
   * the product UI; the direct/registered helpers below drive
   * `document-sync:open-test`, which is not identity-aware, so they pass it
   * themselves.
   */
  private testAuthQuery(label: CollabClientLabel): string {
    return new URLSearchParams({
      test_user_id: this.users[label],
      test_org_id: this.orgId,
    }).toString();
  }

  async openDocumentDirect(
    label: CollabClientLabel,
    params: { documentId: string; title: string; documentType: string }
  ): Promise<void> {
    const page = this.getClient(label).page;
    await page.waitForFunction(
      () => typeof (window as any).__openCollabDocTest === "function",
      undefined,
      { timeout: 30_000 }
    );
    await page.evaluate(
      async ({
        documentId,
        title,
        documentType,
        serverUrl,
        orgId,
        teamMemberId,
        urlExtraQuery,
      }) => {
        await (window as any).__openCollabDocTest({
          documentId,
          title,
          documentType,
          serverUrl,
          orgId,
          teamMemberId,
          urlExtraQuery,
        });
      },
      {
        ...params,
        serverUrl: this.serverUrl,
        orgId: this.orgId,
        teamMemberId: this.users[label],
        urlExtraQuery: this.testAuthQuery(label),
      }
    );
  }

  async registerDocumentConfig(
    label: CollabClientLabel,
    params: { documentId: string; title: string; documentType: string }
  ): Promise<void> {
    const page = this.getClient(label).page;
    await page.waitForFunction(
      () => typeof (window as any).__registerCollabConfigTest === "function",
      undefined,
      { timeout: 30_000 }
    );
    await page.evaluate(
      async ({
        documentId,
        title,
        documentType,
        serverUrl,
        orgId,
        teamMemberId,
        urlExtraQuery,
      }) => {
        await (window as any).__registerCollabConfigTest({
          documentId,
          title,
          documentType,
          serverUrl,
          orgId,
          teamMemberId,
          urlExtraQuery,
        });
      },
      {
        ...params,
        serverUrl: this.serverUrl,
        orgId: this.orgId,
        teamMemberId: this.users[label],
        urlExtraQuery: this.testAuthQuery(label),
      }
    );
  }

  async exportDocument(
    label: CollabClientLabel,
    params: { documentId: string; title: string; documentType: string }
  ): Promise<string> {
    await this.registerDocumentConfig(label, params);
    const result = (await this.getClient(label).page.evaluate(
      async ({ documentId, documentType }) =>
        (window as any).__exportCollabDocTest({
          documentId,
          documentType,
        }),
      params
    )) as { ok: boolean; content?: string; error?: string };
    if (!result.ok || typeof result.content !== "string") {
      throw new Error(
        `Could not export shared document: ${result.error ?? "missing content"}`
      );
    }
    return result.content;
  }

  async waitForDocumentReady(
    label: CollabClientLabel,
    editorSelector: string
  ): Promise<void> {
    const page = this.getClient(label).page;
    await page
      .locator(`${editorSelector}:visible`)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await page
      .locator(".collab-hydration-overlay")
      .waitFor({ state: "hidden", timeout: 20_000 });
  }

  async waitForDurableOutbox(
    label: CollabClientLabel,
    documentId: string,
    expectedPending: boolean
  ): Promise<void> {
    const client = this.getClient(label);
    await client.page.waitForFunction(
      async ({ workspace, accountId, orgId, documentId, expectedPending }) => {
        const rows = await (
          window as any
        ).electronAPI.documentSync.replicaLoadOutbox(workspace, {
          accountId,
          orgId,
          documentId,
        });
        return rows.length > 0 === expectedPending;
      },
      {
        workspace: client.workspace,
        accountId: client.userId,
        orgId: this.orgId,
        documentId,
        expectedPending,
      },
      { timeout: 15_000 }
    );
  }

  async loadDurableReplicaDocument(
    label: CollabClientLabel,
    documentId: string
  ): Promise<Y.Doc> {
    const client = this.getClient(label);
    const loaded = (await client.page.evaluate(
      async ({ workspace, accountId, orgId, documentId }) => {
        const replica = await (
          window as any
        ).electronAPI.documentSync.replicaLoad(workspace, {
          accountId,
          orgId,
          documentId,
        });
        if (!replica) return null;
        return {
          completeness: replica.completeness,
          snapshot: replica.snapshot
            ? Array.from(replica.snapshot as Uint8Array)
            : null,
          updates: replica.updates.map((entry: { update: Uint8Array }) =>
            Array.from(entry.update)
          ),
        };
      },
      {
        workspace: client.workspace,
        accountId: client.userId,
        orgId: this.orgId,
        documentId,
      }
    )) as {
      completeness: string;
      snapshot: number[] | null;
      updates: number[][];
    } | null;
    if (!loaded || loaded.completeness !== "complete") {
      throw new Error(`Local replica for ${documentId} is not complete`);
    }
    const yDoc = new Y.Doc();
    if (loaded.snapshot) Y.applyUpdate(yDoc, Uint8Array.from(loaded.snapshot));
    for (const update of loaded.updates)
      Y.applyUpdate(yDoc, Uint8Array.from(update));
    return yDoc;
  }

  private getClient(label: CollabClientLabel): TwoClientCollabClient {
    const client = this.clients.get(label);
    if (!client)
      throw new Error(`Collaboration client ${label} is not running`);
    return client;
  }

  private async launchClient(
    label: CollabClientLabel,
    preserveState: boolean
  ): Promise<TwoClientCollabClient> {
    const workspace = this.workspaces.get(label);
    const userDataDir = this.userDataDirs.get(label);
    if (!workspace || !userDataDir)
      throw new Error(`Client ${label} directories are not initialized`);
    if (!preserveState) {
      await fs
        .rm(userDataDir, { recursive: true, force: true })
        .catch(() => undefined);
    }

    const app = await launchElectronApp({
      workspace,
      permissionMode: "allow-all",
      preserveTestDatabase: true,
      recordVideo: { dir: this.videoDir },
      env: {
        NIMBALYST_RELEASE_CHANNEL: "alpha",
        NIMBALYST_USER_DATA_DIR: userDataDir,
        NIMBALYST_USER_DATA_PATH: userDataDir,
        NIMBALYST_CDP_PORT: label === "A" ? "9333" : "9334",
        NIMBALYST_E2E_COLLAB_SERVER_URL: this.serverUrl,
        NIMBALYST_E2E_COLLAB_ORG_ID: this.orgId,
        NIMBALYST_E2E_COLLAB_USER_ID: this.users[label],
        NIMBALYST_E2E_EXTENSIONS_DIR: this.extensionDir,
      },
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page
        .locator(
          '.workspace-sidebar:visible, [data-testid="collab-sidebar"]:visible'
        )
        .first()
        .waitFor({ state: "visible", timeout: 20_000 });
      await dismissProjectTrustToast(page);
      const client = {
        app,
        page,
        userId: this.users[label],
        workspace,
        userDataDir,
      };
      this.clients.set(label, client);
      return client;
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
  }

  /** The org owner used by every internal seeding call. */
  readonly ownerUserId = "test-owner";

  /**
   * POST to a TeamRoom `/internal/` endpoint as the org owner.
   *
   * Exposed because a browser client connects with `test_enforce_gate=1` -- it
   * runs the real project-access gate rather than the dev bypass the Electron
   * clients rely on -- so a cross-host spec has to seed membership and a
   * project before it can join anything.
   */
  async postInternal(
    internalPath: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const url = new URL(
      `http://127.0.0.1:${this.port}/sync/org:${this.orgId}:team/internal/${internalPath}`
    );
    url.searchParams.set("test_user_id", this.ownerUserId);
    url.searchParams.set("test_org_id", this.orgId);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `${internalPath} failed: ${response.status} ${await response.text()}`
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Add an org member with edit access to a project, and return the server's
   * `teamProjectId` for it. Idempotent per project name.
   */
  async provisionProjectMember(params: {
    userId: string;
    projectId: string;
    name?: string;
    role?: "owner" | "admin" | "member";
  }): Promise<string> {
    await this.postInternal("add-member", {
      userId: params.userId,
      role: params.role ?? "member",
      name: params.name ?? params.userId,
      email: `${params.userId}@example.test`,
      actorUserId: this.ownerUserId,
    });
    const project = (await this.postInternal("add-project", {
      projectId: params.projectId,
      createdBy: this.ownerUserId,
      name: params.projectId,
    })) as { teamProjectId?: unknown } | null;
    const teamProjectId = project?.teamProjectId;
    if (typeof teamProjectId !== "string" || !teamProjectId) {
      throw new Error("add-project did not mint a teamProjectId");
    }
    await this.postInternal("grant-project-access", {
      projectId: teamProjectId,
      userId: params.userId,
      projectRole: "project-editor",
      actorUserId: this.ownerUserId,
    });
    return teamProjectId;
  }

  /** Mirrors the collab server integration helper before either client connects. */
  private async makeOrgServerManaged(): Promise<void> {
    await this.postInternal("set-metadata", {
      orgId: this.orgId,
      name: this.orgId,
      createdBy: this.ownerUserId,
    });
    // TeamRoom's membership policy now requires the authenticated creator to
    // install itself as the initial owner before it may add another member or
    // grant project access. `set-metadata` records who created the team but does
    // not create that roster row. Without this bootstrap the cross-host harness
    // fails in setup with "Only admins can perform this action" and never opens
    // a document.
    await this.postInternal("add-member", {
      userId: this.ownerUserId,
      role: "owner",
      email: `${this.ownerUserId}@example.test`,
      actorUserId: this.ownerUserId,
    });
    await this.postInternal("set-key-custody-mode", {
      mode: "server-managed",
      actorUserId: this.ownerUserId,
    });
  }

  private async installExtensionFixtures(): Promise<void> {
    await fs.mkdir(this.extensionDir, { recursive: true });
    for (const extension of this.options.extensions ?? []) {
      const manifestPath = path.join(extension.path, "manifest.json");
      const distPath = path.join(extension.path, "dist", "index.js");
      await Promise.all([fs.access(manifestPath), fs.access(distPath)]).catch(
        () => {
          throw new Error(
            `Extension ${extension.id} must have manifest.json and dist/index.js: ${extension.path}`
          );
        }
      );
      const link = path.join(this.extensionDir, extension.id);
      try {
        const existingTarget = await fs.realpath(link);
        if (existingTarget !== (await fs.realpath(extension.path))) {
          throw new Error(
            `Extension fixture path already exists with another target: ${link}`
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.symlink(extension.path, link);
        this.ownedExtensionLinks.push(link);
      }
    }
  }

  private async writeWorkspaceFixtures(): Promise<void> {
    for (const fixture of this.options.files ?? []) {
      for (const label of this.launchedClients) {
        if (
          fixture.client &&
          fixture.client !== "both" &&
          fixture.client !== label
        )
          continue;
        const workspace = this.workspaces.get(label);
        if (!workspace)
          throw new Error(`Workspace ${label} is not initialized`);
        const target = path.join(workspace, fixture.relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, fixture.content);
      }
    }
  }
}
