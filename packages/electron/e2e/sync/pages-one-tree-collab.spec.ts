/**
 * Wrangler-backed acceptance test for the one page tree (Phase 3b) with two
 * clients against a local collab worker.
 *
 * The TeamRoom starts in legacy folder mode (dev hook). Client A creates a
 * folder and places a team type in it; a TeamRoom restart runs the page-tree
 * conversion, after which the folder is a page on both clients and the server
 * snapshot carries `pageTree`. Then, on one tree:
 *   - A creates a page inside the converted page; B sees it nested.
 *   - An item of the type (which sits under the converted page) shows under the
 *     type on both clients.
 *   - A moves the item under the child page (item placement); B sees it there
 *     and the type page's Where column names that page.
 *   - A deletes a page with a child; both are gone on both clients and the
 *     type's prose (the type sits elsewhere) survives.
 *   - A runs Set type on a plain page with a body; B sees the typed page in the
 *     same position with the same body, and the old page is in Trash. This
 *     needs the item's team body room, which main opens only for a workspace
 *     findTeamForWorkspace resolves; the harness identity does not resolve one
 *     yet, so this step fails until it does.
 * Every tree mutation is also checked on the server through the TeamRoom.
 *
 * Tracker item sync is connected through `tracker-sync:connect-test` (the
 * harness has no client-side team project), as in
 * `pages-type-placement-collab.spec.ts`.
 *
 * Run with:
 *   RUN_COLLAB_TESTS=1 npx playwright test e2e/sync/pages-one-tree-collab.spec.ts --max-failures=1
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import WebSocket from "ws";

import { TwoClientCollabHarness } from "../utils/twoClientCollab";

test.skip(
  () => !process.env.RUN_COLLAB_TESTS,
  "Requires RUN_COLLAB_TESTS=1 and wrangler dev"
);
test.describe.configure({ mode: "serial" });
// A missed selector fails in seconds instead of eating the whole test timeout.
test.use({ actionTimeout: 15_000 });

const PORT = 8798;
const TYPE_ID = "kp-onetree";
const TYPE_PLURAL = "Tree Modules";

const LEGACY_FOLDER = "Legacy Folder";
const CHILD_PAGE = "Child Page";
const PLAIN_PAGE = "Plain Page";
const PLAIN_SENTENCE = "This page keeps its words when it gets a type.";
const DOOMED_PAGE = "Doomed Page";
const DOOMED_CHILD = "Doomed Child";
const TYPE_PROSE = "Prose for the tree modules type.";

const TYPE_YAML = `type: ${TYPE_ID}
displayName: Tree Module
displayNamePlural: ${TYPE_PLURAL}
icon: view_module
color: '#0f766e'
modes:
  inline: true
  fullDocument: true
idPrefix: ktm
idFormat: ulid
fields:
  - name: title
    type: string
    required: true
    displayInline: true
  - name: status
    type: select
    required: false
    default: current
    displayInline: true
    options:
      - value: current
        label: Current
      - value: planned
        label: Planned
roles:
  title: title
  workflowStatus: status
sharing: team
draftByDefault: false
`;

function log(message: string): void {
  console.log(`[P3b-E] ${message}`);
}

function captureConsole(page: Page, label: string, sink: string[]): void {
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" ||
      message.type() === "warning" ||
      /placement|pageTree|TeamSync|tracker-sync|CollabMode|setPageType|Set type/i.test(
        text
      )
    ) {
      sink.push(`[${label}] ${message.type()}: ${text.slice(0, 400)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Server-side evidence (TeamRoom as the org owner)
// ---------------------------------------------------------------------------

interface ServerDoc {
  documentId: string;
  /** Plaintext in server-managed mode (titleIv ''). */
  encryptedTitle: string;
  titleIv: string;
  parentFolderId: string | null;
  trashedAt: number | null;
}

interface ServerItemPlacement {
  itemId: string;
  parentId: string | null;
}

interface ServerTypePlacement {
  typeId: string;
  parentFolderId: string | null;
}

interface ServerTeamState {
  pageTree?: true;
  folders?: Array<Record<string, unknown>>;
  typePlacements?: ServerTypePlacement[];
  itemPlacements?: ServerItemPlacement[];
}

function teamUrl(harness: TwoClientCollabHarness, protocol: "ws" | "http", suffix = ""): URL {
  const url = new URL(
    `${protocol}://127.0.0.1:${harness.port}/sync/org:${harness.orgId}:team${suffix}`
  );
  url.searchParams.set("test_user_id", harness.ownerUserId);
  url.searchParams.set("test_org_id", harness.orgId);
  return url;
}

async function serverRequest<T>(
  harness: TwoClientCollabHarness,
  request: Record<string, unknown>,
  responseType: string
): Promise<T> {
  const socket = new WebSocket(teamUrl(harness, "ws"));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`TeamRoom socket did not open for ${String(request.type)}`)),
        10_000
      );
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${String(request.type)} timed out`)),
        10_000
      );
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === responseType) {
          clearTimeout(timeout);
          resolve(message as T);
        } else if (message.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`${String(message.code)}: ${String(message.message)}`));
        }
      });
      socket.send(JSON.stringify(request));
    });
  } finally {
    socket.close();
  }
}

async function serverTeam(harness: TwoClientCollabHarness): Promise<ServerTeamState> {
  const response = await serverRequest<{ team: ServerTeamState }>(
    harness,
    { type: "teamSync" },
    "teamSyncResponse"
  );
  return response.team;
}

async function serverDocs(harness: TwoClientCollabHarness): Promise<ServerDoc[]> {
  const response = await serverRequest<{ documents: ServerDoc[] }>(
    harness,
    { type: "docIndexSync" },
    "docIndexSyncResponse"
  );
  return response.documents;
}

/**
 * New markdown pages are stored with a path-style title ("Parent/Name.md");
 * converted folders are stored with their bare name. Compare the page name.
 */
function stripMd(title: string): string {
  return title.split("/").pop()!.replace(/\.md$/, "");
}

async function serverDocByTitle(
  harness: TwoClientCollabHarness,
  title: string
): Promise<ServerDoc | undefined> {
  return (await serverDocs(harness)).find(
    (doc) => doc.titleIv === "" && stripMd(doc.encryptedTitle) === title
  );
}

async function postDevHook(harness: TwoClientCollabHarness, hook: string): Promise<void> {
  const response = await fetch(teamUrl(harness, "http", `/internal/${hook}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.text();
  // A restart severs its own response; wrangler reports that as a 500 with the reason.
  if (!response.ok && !body.includes("TeamRoom integration-test restart")) {
    throw new Error(`${hook} failed: ${response.status} ${body}`);
  }
}

async function primaryTeamProjectId(harness: TwoClientCollabHarness): Promise<string> {
  const url = teamUrl(harness, "http", "/internal/get-metadata");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`get-metadata failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { teamProjectId?: string | null };
  if (!body.teamProjectId) throw new Error("org has no primary project");
  return body.teamProjectId;
}

async function connectTrackerSync(
  page: Page,
  payload: {
    workspacePath: string;
    serverUrl: string;
    teamProjectId: string;
    orgId: string;
    teamMemberId: string;
  }
): Promise<void> {
  const result = (await page.evaluate(
    (input) => (window as any).electronAPI.invoke("tracker-sync:connect-test", input),
    payload
  )) as { success?: boolean; error?: string };
  if (!result?.success) {
    throw new Error(`tracker-sync:connect-test failed: ${result?.error}`);
  }
  await expect(async () => {
    const status = await page.evaluate(
      async (workspacePath) =>
        (
          await (window as any).electronAPI.invoke("tracker-sync:get-status", {
            workspacePath,
          })
        )?.status,
      payload.workspacePath
    );
    expect(status).toBe("connected");
  }).toPass({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Tree locators and actions
// ---------------------------------------------------------------------------

function sidebar(page: Page): Locator {
  return page.locator('[data-testid="collab-sidebar"]:visible');
}

function folderRow(page: Page, name: string): Locator {
  return sidebar(page).locator(
    'button.file-tree-directory:not([data-testid="collab-tree-type-row"])',
    { hasText: name }
  );
}

function pageRow(page: Page, name: string): Locator {
  return sidebar(page).locator(
    '.file-tree-file:not([data-testid="collab-tree-item-row"])',
    { has: page.locator(".file-tree-name", { hasText: new RegExp(`^${name}(\\.md)?$`) }) }
  );
}

function typeRow(page: Page): Locator {
  return sidebar(page).locator(
    `[data-testid="collab-tree-type-row"][data-type-id="${TYPE_ID}"]`
  );
}

function itemRow(page: Page, itemId: string): Locator {
  return sidebar(page).locator(
    `[data-testid="collab-tree-item-row"][data-item-id="${itemId}"]`
  );
}

/** Expands a collapsed row through its chevron, which never opens a tab. */
async function ensureExpanded(row: Locator): Promise<void> {
  await expect(row).toBeVisible({ timeout: 15_000 });
  const expand = row.locator('[aria-label="Expand"]');
  if (await expand.count()) await expand.click();
}

/** Right-click a page row, "New page inside", name it, confirm. */
async function newPageInside(page: Page, parentName: string, name: string): Promise<void> {
  await pageRow(page, parentName).click({ button: "right" });
  await page.locator(".collab-page-new-inside").click();
  const dialog = page.getByTestId("collab-create-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("collab-create-name-input").fill(name);
  await dialog.locator(".collab-create-confirm").click();
  await expect(dialog).toHaveCount(0);
}

async function waitForServerDoc(
  harness: TwoClientCollabHarness,
  title: string
): Promise<ServerDoc> {
  let found: ServerDoc | undefined;
  try {
    await expect
      .poll(async () => (found = await serverDocByTitle(harness, title))?.documentId ?? null, {
        timeout: 15_000,
      })
      .not.toBeNull();
  } catch (error) {
    log(`server docs while waiting for "${title}": ${JSON.stringify(await serverDocs(harness))}`);
    throw error;
  }
  return found!;
}

function collabEditor(page: Page, orgId: string, documentId: string): Locator {
  return page.locator(
    `.collaborative-tab-editor[data-file-path="collab://org:${orgId}:doc:${documentId}"] [contenteditable="true"]`
  );
}

test("one page tree: conversion, nesting, item placement, subtree delete and set type sync across two clients", async () => {
  test.setTimeout(420_000);
  const harness = new TwoClientCollabHarness({
    port: PORT,
    files: [
      {
        relativePath: `.nimbalyst/trackers/${TYPE_ID}.yaml`,
        content: TYPE_YAML,
        client: "both",
      },
      { relativePath: "README.md", content: "# Pages\n", client: "both" },
    ],
    // The room starts as a pre-Pages room would: folders, no page tree.
    beforeClientsLaunch: (h) => postDevHook(h, "test-folder-mode"),
  });
  const consoleLines: string[] = [];
  const itemId = `ktm-e2e-${harness.runId}`;
  const itemTitle = `Tree item ${harness.runId}`;
  let legacyId = "";
  let childId = "";

  try {
    await harness.start();
    const pageA = harness.clientA.page;
    const pageB = harness.clientB.page;
    captureConsole(pageA, "A", consoleLines);
    captureConsole(pageB, "B", consoleLines);
    await Promise.all([harness.openSharedMode("A"), harness.openSharedMode("B")]);
    expect((await serverTeam(harness)).pageTree).toBeUndefined();
    log("step 0 ok: both clients in Pages mode; server room in folder mode");

    const teamProjectId = await primaryTeamProjectId(harness);
    const serverUrl = `http://127.0.0.1:${harness.port}`;
    await Promise.all([
      connectTrackerSync(pageA, {
        workspacePath: harness.clientA.workspace,
        serverUrl,
        teamProjectId,
        orgId: harness.orgId,
        teamMemberId: harness.users.A,
      }),
      connectTrackerSync(pageB, {
        workspacePath: harness.clientB.workspace,
        serverUrl,
        teamProjectId,
        orgId: harness.orgId,
        teamMemberId: harness.users.B,
      }),
    ]);
    log(`step 0 tracker sync connected on both (project ${teamProjectId})`);

    // ---- Step 1: a legacy folder with a placed type converts into a page.
    await test.step("a folder with a placed type converts into a page", async () => {
      await pageA.getByTestId("window-top-bar-create-left-menu-button").click();
      const menu = pageA.getByTestId("window-top-bar-create-left-menu");
      await expect(menu).toBeVisible();
      await menu.getByText("New folder", { exact: true }).click();
      const dialog = pageA.getByTestId("collab-create-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("collab-create-name-input").fill(LEGACY_FOLDER);
      await dialog.locator(".collab-create-confirm").click();
      await expect(dialog).toHaveCount(0);
      await expect(folderRow(pageA, LEGACY_FOLDER)).toBeVisible({ timeout: 10_000 });

      await folderRow(pageA, LEGACY_FOLDER).click({ button: "right" });
      await pageA.locator(".collab-place-type-action").click();
      const placeMenu = pageA.locator(".collab-place-type-menu");
      await expect(placeMenu).toBeVisible();
      await placeMenu.locator(".collab-place-type-option", { hasText: TYPE_PLURAL }).click();

      // Folder mode on the server: the folder and the placement under it.
      let team: ServerTeamState = {};
      await expect
        .poll(
          async () => {
            team = await serverTeam(harness);
            return team.typePlacements?.find((p) => p.typeId === TYPE_ID)?.parentFolderId ?? null;
          },
          { timeout: 15_000 }
        )
        .not.toBeNull();
      legacyId = team.typePlacements!.find((p) => p.typeId === TYPE_ID)!.parentFolderId!;
      expect(team.folders?.length).toBe(1);
      log(`step 1 folder mode ok: folder ${legacyId} with the type placed in it`);

      // A TeamRoom restart runs the one-time conversion.
      await postDevHook(harness, "test-restart");
      await expect
        .poll(async () => (await serverTeam(harness)).pageTree ?? false, { timeout: 20_000 })
        .toBe(true);
      const converted = (await serverDocs(harness)).find((d) => d.documentId === legacyId);
      expect(converted, "converted folder is a document row").toBeTruthy();
      expect(converted!.encryptedTitle).toBe(LEGACY_FOLDER);
      expect(converted!.parentFolderId).toBeNull();
      expect(converted!.trashedAt).toBeNull();
      expect(
        (await serverTeam(harness)).typePlacements?.find((p) => p.typeId === TYPE_ID)
          ?.parentFolderId
      ).toBe(legacyId);
      log("step 1 server ok: snapshot pageTree, folder is a document, type placement kept");

      for (const page of [pageA, pageB]) {
        await expect(pageRow(page, LEGACY_FOLDER)).toBeVisible({ timeout: 30_000 });
        await ensureExpanded(pageRow(page, LEGACY_FOLDER));
        await expect(typeRow(page)).toBeVisible({ timeout: 10_000 });
      }
      log("step 1 ok: both clients show the converted page with the type under it");
    });

    // ---- Step 2: A creates a page inside the converted page; B sees it nested.
    await test.step("a page inside a page syncs nested", async () => {
      await newPageInside(pageA, LEGACY_FOLDER, CHILD_PAGE);
      const child = await waitForServerDoc(harness, CHILD_PAGE);
      childId = child.documentId;
      expect(child.parentFolderId).toBe(legacyId);
      log(`step 2 server ok: ${CHILD_PAGE} ${childId} has parent ${legacyId}`);
      await ensureExpanded(pageRow(pageB, LEGACY_FOLDER));
      await expect(pageRow(pageB, CHILD_PAGE)).toBeVisible({ timeout: 20_000 });
      log("step 2 ok: B shows the child page");
    });

    // ---- Step 3: an item created on A shows under its type on both clients.
    await test.step("an item shows under its type on both clients", async () => {
      const created = (await pageA.evaluate(
        (payload) =>
          (window as any).electronAPI.invoke("document-service:create-tracker-item", payload),
        {
          id: itemId,
          type: TYPE_ID,
          title: itemTitle,
          status: "current",
          workspace: harness.clientA.workspace,
        }
      )) as { success?: boolean; error?: string };
      expect(created?.success, created?.error).toBe(true);
      for (const page of [pageA, pageB]) {
        await ensureExpanded(typeRow(page));
        await expect(itemRow(page, itemId)).toBeVisible({ timeout: 20_000 });
      }
      log("step 3 ok: item row under the type on A and B");
    });

    // ---- Step 4: A moves the item under the child page.
    await test.step("item placement under a page syncs and shows in Where", async () => {
      await itemRow(pageA, itemId).click({ button: "right" });
      await pageA.locator(".collab-item-move-to").click();
      const moveDialog = pageA.locator(".collab-page-move-dialog");
      await expect(moveDialog).toBeVisible();
      await moveDialog.locator(".collab-page-move-option", { hasText: CHILD_PAGE }).click();
      await moveDialog.locator(".collab-page-move-confirm").click();
      await expect(moveDialog).toHaveCount(0);

      await expect
        .poll(
          async () =>
            (await serverTeam(harness)).itemPlacements?.find((p) => p.itemId === itemId)
              ?.parentId ?? null,
          { timeout: 15_000 }
        )
        .toBe(childId);
      log("step 4 server ok: item placement parent is the child page");

      await ensureExpanded(pageRow(pageB, CHILD_PAGE));
      await expect(itemRow(pageB, itemId)).toBeVisible({ timeout: 20_000 });
      await expect(itemRow(pageB, itemId)).toHaveCount(1);
      log("step 4 ok B: item row under the child page");

      await typeRow(pageB).click();
      const typePage = pageB.locator(
        `[data-testid="type-page-tab"][data-type-id="${TYPE_ID}"]:visible`
      );
      await expect(typePage).toBeVisible({ timeout: 15_000 });
      const table = typePage.getByTestId("type-page-table");
      await expect(table).toContainText(itemTitle, { timeout: 15_000 });
      // The grid renders only columns near its viewport; Where is the last one.
      await expect
        .poll(
          async () => {
            await table.evaluate((root) => {
              for (const el of root.querySelectorAll<HTMLElement>("*")) {
                if (el.scrollWidth > el.clientWidth + 1) el.scrollLeft = el.scrollWidth;
              }
            });
            return (await table.textContent()) ?? "";
          },
          { timeout: 15_000 }
        )
        .toContain(CHILD_PAGE);
      log("step 4 ok B: type page Where column names the child page");
    });

    // ---- Step 5: the type gets prose; a page with a child is deleted.
    await test.step("deleting a page subtree removes it on both; type prose survives", async () => {
      await typeRow(pageA).click();
      const typePage = pageA.locator(
        `[data-testid="type-page-tab"][data-type-id="${TYPE_ID}"]:visible`
      );
      await expect(typePage).toBeVisible({ timeout: 15_000 });
      const start = typePage.getByTestId("type-page-prose-start");
      if (await start.count()) await start.click();
      const prose = typePage.locator('[data-testid="type-page-prose"] [contenteditable="true"]');
      await expect(prose).toBeVisible({ timeout: 15_000 });
      await prose.click();
      await pageA.keyboard.type(TYPE_PROSE);
      await expect(prose).toContainText(TYPE_PROSE);
      const proseDocId = `type-page:${TYPE_ID}`;
      await expect(typePage.getByTestId("type-page-prose")).toHaveAttribute(
        "data-document-id",
        proseDocId
      );
      await expect
        .poll(
          async () => {
            const row = (await serverDocs(harness)).find((d) => d.documentId === proseDocId);
            if (!row) log(`type prose ${proseDocId} not in the server index yet`);
            return row ? row.trashedAt : "missing";
          },
          { timeout: 15_000 }
        )
        .toBeNull();
      log(`step 5 type prose ${proseDocId} registered on the server`);

      await newPageInside(pageA, LEGACY_FOLDER, DOOMED_PAGE);
      const doomed = await waitForServerDoc(harness, DOOMED_PAGE);
      await newPageInside(pageA, DOOMED_PAGE, DOOMED_CHILD);
      const doomedChild = await waitForServerDoc(harness, DOOMED_CHILD);
      expect(doomedChild.parentFolderId).toBe(doomed.documentId);
      await ensureExpanded(pageRow(pageB, DOOMED_PAGE));
      await expect(pageRow(pageB, DOOMED_CHILD)).toBeVisible({ timeout: 20_000 });
      log("step 5 doomed page and its child exist on both");

      await pageRow(pageA, DOOMED_PAGE).click({ button: "right" });
      const del = pageA.locator(".collab-page-delete");
      await expect(del).toContainText("1 child page");
      await del.click();
      const confirmDialog = pageA.getByTestId("collab-confirm-dialog");
      await expect(confirmDialog).toContainText(`Delete "${DOOMED_PAGE}" and its 1 child page?`);
      await confirmDialog.locator(".collab-confirm-accept").click();
      await expect(confirmDialog).toHaveCount(0);

      const isGone = (doc: ServerDoc | undefined) => !doc || doc.trashedAt !== null;
      await expect
        .poll(
          async () => {
            const docs = await serverDocs(harness);
            return (
              isGone(docs.find((d) => d.documentId === doomed.documentId)) &&
              isGone(docs.find((d) => d.documentId === doomedChild.documentId))
            );
          },
          { timeout: 15_000 }
        )
        .toBe(true);
      const docsAfter = await serverDocs(harness);
      expect(docsAfter.find((d) => d.documentId === proseDocId)?.trashedAt).toBeNull();
      expect(docsAfter.find((d) => d.documentId === legacyId)?.trashedAt).toBeNull();
      log("step 5 server ok: subtree gone; type prose and the converted page remain");

      for (const page of [pageA, pageB]) {
        await expect(pageRow(page, DOOMED_PAGE)).toHaveCount(0, { timeout: 15_000 });
        await expect(pageRow(page, DOOMED_CHILD)).toHaveCount(0);
        await expect(typeRow(page)).toBeVisible();
      }
      log("step 5 ok: subtree gone on A and B; the type row remains");
    });
    // ---- Step 6: Set type on a plain page with a body. The item's body room is
    // opened by main (MainBodyDocService) with the harness team identity that
    // CollabTestIdentityHandlers installs.
    let typedItemId = "";
    await test.step("set type keeps position and body; old page goes to Trash", async () => {
      await newPageInside(pageA, LEGACY_FOLDER, PLAIN_PAGE);
      const plain = await waitForServerDoc(harness, PLAIN_PAGE);
      expect(plain.parentFolderId).toBe(legacyId);
      const editor = collabEditor(pageA, harness.orgId, plain.documentId);
      await expect(editor).toBeVisible({ timeout: 15_000 });
      await editor.click();
      await pageA.keyboard.type(PLAIN_SENTENCE);
      await expect(editor).toContainText(PLAIN_SENTENCE);
      // Let the collaborative body reach the room before the copy.
      await pageA.waitForTimeout(1_500);

      const placementsBefore = new Set(
        ((await serverTeam(harness)).itemPlacements ?? []).map((p) => p.itemId)
      );
      await pageRow(pageA, PLAIN_PAGE).click({ button: "right" });
      await pageA.locator(".collab-page-set-type").click();
      const setTypeDialog = pageA.getByTestId("set-page-type-dialog");
      await expect(setTypeDialog).toBeVisible();
      await setTypeDialog.getByTestId(`set-page-type-option-${TYPE_ID}`).click();
      await expect(setTypeDialog).toHaveCount(0, { timeout: 30_000 });

      let placement: ServerItemPlacement | undefined;
      await expect
        .poll(
          async () => {
            placement = ((await serverTeam(harness)).itemPlacements ?? []).find(
              (p) => !placementsBefore.has(p.itemId)
            );
            return placement?.parentId ?? null;
          },
          { timeout: 20_000 }
        )
        .toBe(legacyId);
      typedItemId = placement!.itemId;
      await expect
        .poll(
          async () =>
            (await serverDocs(harness)).find((d) => d.documentId === plain.documentId)
              ?.trashedAt ?? null,
          { timeout: 15_000 }
        )
        .not.toBeNull();
      log(`step 6 server ok: item ${typedItemId} placed under ${legacyId}; old page trashed`);

      await expect(itemRow(pageB, typedItemId)).toBeVisible({ timeout: 20_000 });
      await expect(itemRow(pageB, typedItemId)).toContainText(PLAIN_PAGE);
      await expect(pageRow(pageB, PLAIN_PAGE)).toHaveCount(0, { timeout: 15_000 });
      await itemRow(pageB, typedItemId).click();
      const view = pageB.locator(
        `[data-testid="tracker-page-view"][data-item-id="${typedItemId}"]:visible`
      );
      await expect(view).toBeVisible({ timeout: 15_000 });
      await expect(view).toContainText(PLAIN_SENTENCE, { timeout: 20_000 });
      log("step 6 ok B: typed page in the same position with the same body; plain page row gone");
    });

  } catch (error) {
    // Printed here because a hung app close in cleanup can eat the report.
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    console.log(
      `[P3b-E] renderer console (last 80 relevant lines):\n${consoleLines.slice(-80).join("\n")}`
    );
    throw error;
  } finally {
    await harness.stop();
  }
});
