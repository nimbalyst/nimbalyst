/**
 * Wrangler-backed acceptance test for the team's marks index (Decision 21):
 * a sentence marked decided on a plain team page by client A shows up in a
 * Decisions list that client B places in another page, without B ever opening
 * A's page. Plain team pages live only in their rooms, so B can only learn of
 * the mark through the server's index.
 *
 * Steps:
 *   1. A creates a team page, types a sentence and marks it decided through
 *      the floating toolbar.
 *   2. The TeamRoom answers `pageMarksQuery` with that mark (server state,
 *      read over a raw socket, not a client cache).
 *   3. B creates a page, places "Decisions list" from the slash menu, and the
 *      list shows A's sentence, naming A's page.
 *
 * Run with:
 *   RUN_COLLAB_TESTS=1 npx playwright test e2e/sync/pages-marks-index-collab.spec.ts --max-failures=1
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import WebSocket from "ws";

import { TwoClientCollabHarness } from "../utils/twoClientCollab";

test.skip(
  () => !process.env.RUN_COLLAB_TESTS,
  "Requires RUN_COLLAB_TESTS=1 and wrangler dev"
);
test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

const PORT = 8795;
const MARKED_PAGE = "Storage choices";
const LIST_PAGE = "Decision log";
const SENTENCE = "Pages are stored in the team room.";

function log(message: string): void {
  console.log(`[marks-index] ${message}`);
}

interface ServerMark {
  documentId: string;
  title: string | null;
  kind: string;
  plainText: string;
  by: string | null;
}

/** The TeamRoom's own answer to a marks query, asked as the org owner. */
async function serverMarks(harness: TwoClientCollabHarness): Promise<ServerMark[]> {
  const url = new URL(`ws://127.0.0.1:${harness.port}/sync/org:${harness.orgId}:team`);
  url.searchParams.set("test_user_id", harness.ownerUserId);
  url.searchParams.set("test_org_id", harness.orgId);
  const ws = new WebSocket(url.toString());
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const requestId = `e2e-${Date.now()}`;
    const response = new Promise<ServerMark[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no pageMarksResponse")), 8_000);
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "pageMarksResponse" && message.requestId === requestId) {
          clearTimeout(timer);
          resolve(message.marks);
        }
      });
    });
    ws.send(JSON.stringify({ type: "pageMarksQuery", requestId, kind: "decided" }));
    return await response;
  } finally {
    ws.close();
  }
}

/** New root page in the team section, opened in a tab; returns its editor. */
async function createTeamPage(page: Page, orgId: string, name: string): Promise<Locator> {
  await page.getByTestId("window-top-bar-create-left").click();
  const dialog = page.getByTestId("collab-create-dialog");
  await expect(dialog).toBeVisible();
  const root = dialog.getByTestId("collab-create-location-option-root");
  if (await root.count()) await root.click();
  await dialog.getByTestId("collab-create-name-input").fill(name);
  await dialog.locator(".collab-create-confirm").click();
  await expect(dialog).toHaveCount(0);
  const editor = page.locator(
    `.collaborative-tab-editor[data-file-path^="collab://org:${orgId}:doc:"]:visible [contenteditable="true"]`
  );
  await expect(editor).toBeVisible({ timeout: 20_000 });
  return editor;
}

test("a mark on a plain team page appears in the other client's Decisions list", async () => {
  test.setTimeout(240_000);
  const harness = new TwoClientCollabHarness({
    port: PORT,
    files: [{ relativePath: "README.md", content: "# Pages\n", client: "both" }],
  });

  try {
    await harness.start();
    const pageA = harness.clientA.page;
    const pageB = harness.clientB.page;
    await Promise.all([harness.openSharedMode("A"), harness.openSharedMode("B")]);

    await test.step("A marks a sentence decided on a team page", async () => {
      const editor = await createTeamPage(pageA, harness.orgId, MARKED_PAGE);
      await editor.click();
      await pageA.keyboard.type(SENTENCE);
      for (let i = 0; i < SENTENCE.length; i++) await pageA.keyboard.press("Shift+ArrowLeft");
      await pageA.getByTestId("floating-toolbar-action-mark-decided").click();
      const markEditor = pageA.getByTestId("page-mark-editor");
      await expect(markEditor).toBeVisible();
      await markEditor.getByPlaceholder("Name").fill("Ana");
      await markEditor.getByPlaceholder("What was set aside").fill("a body cache");
      await pageA.getByTestId("page-mark-editor-save").click();
      await expect(editor.locator(".page-mark--decided")).toHaveText(SENTENCE);
      log("step 1 ok: A marked the sentence");
    });

    await test.step("the TeamRoom indexes the mark", async () => {
      await expect
        .poll(async () => (await serverMarks(harness)).map((m) => [m.plainText, m.by, m.title]), { timeout: 30_000 })
        .toContainEqual([SENTENCE, "Ana", expect.stringMatching(new RegExp(`^${MARKED_PAGE}`))]);
      log("step 2 ok: server index holds the mark");
    });

    await test.step("B's Decisions list shows A's mark", async () => {
      const editor = await createTeamPage(pageB, harness.orgId, LIST_PAGE);
      await editor.click();
      await pageB.keyboard.type("/Decisions list");
      await pageB.keyboard.press("Enter");
      const list = pageB.locator('[data-testid="marks-list-embed"]:visible');
      await expect(list).toBeVisible({ timeout: 15_000 });
      const row = list.locator(".marks-list-row", { hasText: SENTENCE });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.locator(".marks-list-page")).toContainText(MARKED_PAGE);
      log("step 3 ok: B lists A's decision");
    });
  } finally {
    await harness.stop();
  }
});
