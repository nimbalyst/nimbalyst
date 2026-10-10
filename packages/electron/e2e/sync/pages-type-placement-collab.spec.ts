/**
 * Wrangler-backed acceptance test for typed pages in the team Pages tree.
 *
 * Client A places a team-shared tracker type in the Pages tree through the
 * real "Place type..." menu. The placement goes through the local TeamRoom and
 * must reach client B's tree without a reload. An item of that type created on
 * A must then show under the type on both clients, open as a `tracker://` page
 * tab with a single-valued header on B, and the type row must open a
 * `type://` tab with the type's table. Finally B is relaunched with its user
 * data preserved and both page tabs must come back.
 *
 * The harness has no team project on the client side (teamProjectId is null),
 * so tracker item sync is connected through `tracker-sync:connect-test`, the
 * same real-engine path `tracker-sync-collab.spec.ts` uses, against the org's
 * primary project. Placement sync uses the product path untouched.
 *
 * Run with:
 *   RUN_COLLAB_TESTS=1 npx playwright test e2e/sync/pages-type-placement-collab.spec.ts --max-failures=1
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import WebSocket from "ws";

import { TwoClientCollabHarness } from "../utils/twoClientCollab";

test.skip(
  () => !process.env.RUN_COLLAB_TESTS,
  "Requires RUN_COLLAB_TESTS=1 and wrangler dev"
);
test.describe.configure({ mode: "serial" });

const PORT = 8799;
const TYPE_ID = "kp-module";
const TYPE_PLURAL = "Placement Modules";

const TYPE_YAML = `type: ${TYPE_ID}
displayName: Placement Module
displayNamePlural: ${TYPE_PLURAL}
icon: view_module
color: '#0f766e'
modes:
  inline: true
  fullDocument: true
idPrefix: kpm
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
  - name: priority
    type: select
    required: false
    default: medium
    displayInline: true
    options:
      - value: low
        label: Low
      - value: medium
        label: Medium
      - value: high
        label: High
  - name: platforms
    type: multiselect
    required: false
    displayInline: true
    options:
      - value: desktop
        label: Desktop
      - value: web
        label: Web
  - name: dependsOn
    type: relationship
    required: false
    displayInline: true
    relationshipTypeKey: depends-on
    targetTrackerTypes:
      - ${TYPE_ID}
    multiValue: true
  - name: tags
    type: array
    required: false
    displayInline: false
    itemType: string
statusBarLayout:
  - row:
      - field: status
        width: 160
      - field: priority
        width: 140
      - field: platforms
        width: 180
      - field: dependsOn
        width: 200
roles:
  title: title
  workflowStatus: status
  priority: priority
  tags: tags
sharing: team
draftByDefault: false
`;

function log(message: string): void {
  console.log(`[P1-E] ${message}`);
}

/** Collects renderer console lines that look relevant, for failure diagnosis. */
function captureConsole(page: Page, label: string, sink: string[]): void {
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" ||
      message.type() === "warning" ||
      /placement|typePlacement|TeamSync|tracker-sync|CollabMode|TrackerSync/i.test(
        text
      )
    ) {
      sink.push(`[${label}] ${message.type()}: ${text.slice(0, 400)}`);
    }
  });
}

async function primaryTeamProjectId(
  harness: TwoClientCollabHarness
): Promise<string> {
  const url = new URL(
    `http://127.0.0.1:${harness.port}/sync/org:${harness.orgId}:team/internal/get-metadata`
  );
  url.searchParams.set("test_user_id", harness.ownerUserId);
  url.searchParams.set("test_org_id", harness.orgId);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `get-metadata failed: ${response.status} ${await response.text()}`
    );
  }
  const body = (await response.json()) as { teamProjectId?: string | null };
  if (!body.teamProjectId) throw new Error("org has no primary project");
  return body.teamProjectId;
}

/** Reads the TeamRoom's placement list as the org owner: server-side evidence. */
async function serverPlacements(
  harness: TwoClientCollabHarness
): Promise<Array<{ typeId: string; parentFolderId: string | null }>> {
  const url = new URL(
    `ws://127.0.0.1:${harness.port}/sync/org:${harness.orgId}:team`
  );
  url.searchParams.set("test_user_id", harness.ownerUserId);
  url.searchParams.set("test_org_id", harness.orgId);
  const socket = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("typePlacementIndexSync timed out")),
        10_000
      );
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          placements?: Array<{ typeId: string; parentFolderId: string | null }>;
          code?: string;
          message?: string;
        };
        if (message.type === "typePlacementIndexSyncResponse") {
          clearTimeout(timeout);
          resolve(message.placements ?? []);
        } else if (message.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`${message.code}: ${message.message}`));
        }
      });
      socket.send(JSON.stringify({ type: "typePlacementIndexSync" }));
    });
  } finally {
    socket.close();
  }
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
    (input) =>
      (window as any).electronAPI.invoke("tracker-sync:connect-test", input),
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

function sidebar(page: Page): Locator {
  return page.locator('[data-testid="collab-sidebar"]:visible');
}

function typeRow(page: Page): Locator {
  return sidebar(page).locator(
    `[data-testid="collab-tree-type-row"][data-type-id="${TYPE_ID}"]`
  );
}

function itemRow(page: Page, title: string): Locator {
  return sidebar(page).locator('[data-testid="collab-tree-item-row"]', {
    hasText: title,
  });
}

test("a placed team type and its items sync, open as pages, and restore", async () => {
  test.setTimeout(240_000);
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
  });
  const consoleLines: string[] = [];
  const itemTitle = `Placement item ${harness.runId}`;
  const itemId = `kpm-e2e-${harness.runId}`;

  try {
    await harness.start();
    captureConsole(harness.clientA.page, "A", consoleLines);
    captureConsole(harness.clientB.page, "B", consoleLines);

    await Promise.all([
      harness.openSharedMode("A"),
      harness.openSharedMode("B"),
    ]);
    log("step 0 ok: both clients in Pages mode, 'Team synced' visible");

    // ---- Step 1: A places the type at the tree root via the context menu.
    await test.step("A places the type via Place type...", async () => {
      const pageA = harness.clientA.page;
      const tree = sidebar(pageA).locator(".collab-sidebar-tree");
      await expect(tree).toBeVisible({ timeout: 10_000 });
      const box = await tree.boundingBox();
      if (!box) throw new Error("Pages tree has no box on A");
      await pageA.mouse.click(
        box.x + box.width / 2,
        box.y + box.height - 12,
        { button: "right" }
      );
      // Empty tree space opens New page / Place type...
      await pageA.locator(".collab-section-place-type").click();
      const menu = pageA.locator(".collab-place-type-menu");
      await expect(menu).toBeVisible({ timeout: 5_000 });
      const option = menu.locator(".collab-place-type-option", {
        hasText: TYPE_PLURAL,
      });
      await expect(option).toHaveCount(1, { timeout: 10_000 });
      await option.click();
      await expect(typeRow(pageA)).toBeVisible({ timeout: 10_000 });
      log(`step 1 ok: A tree shows type row data-type-id=${TYPE_ID}`);

      await expect
        .poll(async () => (await serverPlacements(harness)).map((p) => p.typeId), {
          timeout: 15_000,
        })
        .toContain(TYPE_ID);
      log("step 1 server ok: TeamRoom typePlacementIndexSync lists the type");
    });

    // ---- Step 2: B sees the type node without a reload.
    await test.step("B sees the type node via sync", async () => {
      await expect(typeRow(harness.clientB.page)).toBeVisible({
        timeout: 20_000,
      });
      log("step 2 ok: B tree shows type row without reload");
    });

    // ---- Step 3: an item created on A shows under the type on both clients.
    await test.step("item created on A appears under the type on A and B", async () => {
      const teamProjectId = await primaryTeamProjectId(harness);
      const serverUrl = `http://127.0.0.1:${harness.port}`;
      await Promise.all([
        connectTrackerSync(harness.clientA.page, {
          workspacePath: harness.clientA.workspace,
          serverUrl,
          teamProjectId,
          orgId: harness.orgId,
          teamMemberId: harness.users.A,
        }),
        connectTrackerSync(harness.clientB.page, {
          workspacePath: harness.clientB.workspace,
          serverUrl,
          teamProjectId,
          orgId: harness.orgId,
          teamMemberId: harness.users.B,
        }),
      ]);
      log(`step 3 tracker sync connected on both (project ${teamProjectId})`);

      const created = (await harness.clientA.page.evaluate(
        (payload) =>
          (window as any).electronAPI.invoke(
            "document-service:create-tracker-item",
            payload
          ),
        {
          id: itemId,
          type: TYPE_ID,
          title: itemTitle,
          status: "current",
          priority: "high",
          workspace: harness.clientA.workspace,
          tags: ["alpha"],
          customFields: { platforms: ["desktop", "web"] },
        }
      )) as { success?: boolean; error?: string; item?: { syncStatus?: string } };
      expect(created?.success, created?.error).toBe(true);
      log(`step 3 created on A, syncStatus=${created?.item?.syncStatus}`);

      await expect(itemRow(harness.clientA.page, itemTitle)).toBeVisible({
        timeout: 15_000,
      });
      log("step 3 ok A: item row under the type on A");

      const pageB = harness.clientB.page;
      // B's type node is collapsed; expand it with the chevron, which does not open a tab.
      await typeRow(pageB).locator('[aria-label="Expand"]').click();
      await expect(itemRow(pageB, itemTitle)).toBeVisible({ timeout: 20_000 });
      log("step 3 ok B: item row under the type on B");
    });

    // ---- Step 4: the item row on B opens a tracker:// page with a single-valued header.
    await test.step("item row on B opens a tracker page tab", async () => {
      const pageB = harness.clientB.page;
      await itemRow(pageB, itemTitle).click();
      const detail = pageB.locator('[data-testid="tracker-item-detail"]:visible');
      await expect(detail).toBeVisible({ timeout: 15_000 });
      await expect(detail.getByTestId("tracker-detail-title")).toHaveValue(
        itemTitle
      );
      await expect(
        pageB.locator('.tab[data-tab-type="tracker"]:visible')
      ).toHaveCount(1);
      await expect(
        detail.getByTestId("tracker-detail-field-pill-status")
      ).toBeVisible();
      await expect(
        detail.getByTestId("tracker-detail-field-pill-priority")
      ).toBeVisible();
      await expect(
        detail.getByTestId("tracker-detail-field-pill-platforms")
      ).toHaveCount(0);
      await expect(
        detail.getByTestId("tracker-detail-field-pill-dependsOn")
      ).toHaveCount(0);
      await expect(detail.getByTestId("tracker-detail-tags")).toHaveCount(0);
      await expect(
        detail.locator(".tracker-detail-overflow-fields")
      ).toHaveCount(0);
      log(
        "step 4 ok: tracker tab on B; status/priority pills shown; platforms, dependsOn, tags absent"
      );
    });

    // ---- Step 5: the type row opens a type:// tab with the type's table.
    await test.step("type row on B opens a type page tab", async () => {
      const pageB = harness.clientB.page;
      await typeRow(pageB).click();
      const typePage = pageB.locator(
        `[data-testid="type-page-tab"][data-type-id="${TYPE_ID}"]:visible`
      );
      await expect(typePage).toBeVisible({ timeout: 15_000 });
      await expect(typePage.locator("h1")).toContainText(TYPE_PLURAL);
      const table = typePage.getByTestId("tracker-saved-view-embed");
      await expect(table).toBeVisible({ timeout: 10_000 });
      await expect(table).toContainText(itemTitle, { timeout: 10_000 });
      log("step 5 ok: type tab on B renders the table with the item");
    });

    // ---- Step 6: relaunch B (user data preserved); both page tabs come back.
    await test.step("B restarts and restores the item and type tabs", async () => {
      // Let the tab persistence effect write before the app closes.
      await harness.clientB.page.waitForTimeout(1_000);
      await harness.restartClient("B");
      captureConsole(harness.clientB.page, "B2", consoleLines);
      await harness.openSharedMode("B");
      const pageB = harness.clientB.page;
      const trackerTab = pageB.locator('.tab[data-tab-type="tracker"]:visible');
      const typeTab = pageB.locator(
        `.tab[data-filename="${TYPE_PLURAL}"]:visible`
      );
      await expect(trackerTab).toHaveCount(1, { timeout: 20_000 });
      await expect(typeTab).toHaveCount(1, { timeout: 20_000 });
      log("step 6 tabs present after relaunch");

      await trackerTab.click();
      const detail = pageB.locator('[data-testid="tracker-item-detail"]:visible');
      await expect(detail.getByTestId("tracker-detail-title")).toHaveValue(
        itemTitle,
        { timeout: 15_000 }
      );
      await typeTab.click();
      await expect(
        pageB.locator(
          `[data-testid="type-page-tab"][data-type-id="${TYPE_ID}"]:visible`
        )
      ).toBeVisible({ timeout: 15_000 });
      log("step 6 ok: restored item and type tabs render after relaunch");
    });
  } catch (error) {
    console.log(
      `[P1-E] renderer console (last 80 relevant lines):\n${consoleLines
        .slice(-80)
        .join("\n")}`
    );
    throw error;
  } finally {
    await harness.stop();
  }
});
