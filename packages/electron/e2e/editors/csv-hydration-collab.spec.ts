import { expect, test, type Page } from "@playwright/test";
import * as path from "node:path";
import WebSocket from "ws";
import * as Y from "yjs";
import type { DocSyncResponseMessage } from "@nimbalyst/collab-protocol";
import { parseCSV } from "../../../extensions/csv-spreadsheet/src/utils/csvParser";
import { TwoClientCollabHarness } from "../utils/twoClientCollab";
import {
  openFileFromTree,
  PLAYWRIGHT_TEST_SELECTORS as S,
} from "../utils/testHelpers";

test.skip(
  () => !process.env.RUN_COLLAB_TESTS,
  "Requires the local collaboration server"
);
const filename = "hydration-safety.csv";
const rows = [
  ["Name", "Value"],
  ...Array.from({ length: 60 }, (_, i) => [
    `Row ${i}`,
    i === 29 ? "quoted,\nmultiline" : String(i),
  ]),
];
const seed =
  '# nimbalyst: {"headerRowCount":1,"hasHeaders":true}\n' +
  rows
    .map((row) =>
      row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")
    )
    .join("\n");
const harness = new TwoClientCollabHarness({
  port: 8796,
  extensions: [
    {
      id: "com.nimbalyst.csv-spreadsheet",
      path: path.resolve(__dirname, "../../../extensions/csv-spreadsheet"),
    },
  ],
  files: [{ relativePath: filename, content: seed, client: "A" }],
});

async function gridRows(page: Page): Promise<string[][]> {
  return page
    .locator(S.spreadsheetGrid)
    .filter({ visible: true })
    .evaluate(async (element) => {
      const grid = element as unknown as {
        getSource(section: string): Promise<Record<string, unknown>[]>;
      };
      const [source, pinned] = await Promise.all([
        grid.getSource("rgRow"),
        grid.getSource("rowPinStart"),
      ]);
      const all = [...pinned, ...source].map((row) => [
        String(row.A ?? ""),
        String(row.B ?? ""),
      ]);
      while (all.length && all.at(-1)!.every((value) => value === ""))
        all.pop();
      return all;
    });
}

/** Fresh network-only reader: no editor state, local replica, or outgoing updates. */
async function serverRows(documentId: string): Promise<string[][]> {
  const room = `org:${harness.orgId}:doc:${encodeURIComponent(documentId)}`;
  const query = new URLSearchParams({
    test_user_id: harness.users.A,
    test_org_id: harness.orgId,
  });
  const ws = new WebSocket(`${harness.serverUrl}/sync/${room}?${query}`);
  const doc = new Y.Doc();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Fresh document sync timed out")),
        10000
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      ws.on("error", fail);
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "docSyncRequest", sinceSeq: 0 }))
      );
      ws.on("message", (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (message.type === "docError")
            throw new Error(JSON.stringify(message));
          if (message.type !== "docSyncResponse") return;
          const response = message as DocSyncResponseMessage;
          if (response.snapshot) {
            expect(response.snapshot.iv).toBe("");
            Y.applyUpdate(
              doc,
              Buffer.from(response.snapshot.encryptedState, "base64")
            );
          }
          for (const update of response.updates) {
            expect(update.iv).toBe("");
            Y.applyUpdate(doc, Buffer.from(update.encryptedUpdate, "base64"));
          }
          if (response.hasMore)
            ws.send(
              JSON.stringify({
                type: "docSyncRequest",
                sinceSeq: response.cursor,
              })
            );
          else {
            clearTimeout(timer);
            resolve(
              parseCSV(doc.getText("csv").toString()).data.rows.map((row) =>
                row.map((cell) => cell.raw)
              )
            );
          }
        } catch (error) {
          fail(error as Error);
        }
      });
    });
  } finally {
    ws.close();
    doc.destroy();
  }
}

test("opening a large shared CSV retains every pinned and offscreen row on both clients and the server", async () => {
  test.setTimeout(180000);
  try {
    await harness.start();
    const a = harness.clientA.page;
    await openFileFromTree(a, filename);
    await expect.poll(() => gridRows(a)).toEqual(rows);
    await a
      .locator(S.fileTreeItem, { hasText: filename })
      .click({ button: "right" });
    await a.getByText("Share to Team", { exact: true }).click();
    const dialog = a.getByRole("dialog", { name: "Share to Team" });
    await dialog.getByRole("button", { name: /Share to Team$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 20000 });
    await harness.openSharedMode("A");
    await a
      .getByTestId("collab-sidebar")
      .locator(S.fileTreeItem, { hasText: filename })
      .click();
    const title = await a
      .locator(S.tab)
      .filter({ visible: true, hasText: filename })
      .getAttribute("title");
    const documentId = title?.match(/:doc:(.+)$/)?.[1];
    if (!documentId) throw new Error(`Shared tab has no document ID: ${title}`);
    await harness.waitForDurableOutbox("A", documentId, false);
    expect(await serverRows(documentId)).toEqual(rows);
    const b = await harness.openSharedMode("B");
    await b
      .getByTestId("collab-sidebar")
      .locator(S.fileTreeItem, { hasText: filename })
      .click();
    await expect.poll(() => gridRows(b)).toEqual(rows);
    await expect
      .poll(() =>
        b
          .locator(S.spreadsheetGrid)
          .filter({ visible: true })
          .evaluate(
            (grid) => (grid as unknown as { readonly: boolean }).readonly
          )
      )
      .toBe(false);
    // Cover several publication ticks after opening, not just first paint.
    for (let poll = 0; poll < 3; poll++) {
      await a.waitForTimeout(1200);
      expect(await gridRows(a)).toEqual(rows);
      expect(await gridRows(b)).toEqual(rows);
      expect(await serverRows(documentId)).toEqual(rows);
    }
    const sharedTab = b
      .locator(S.tab)
      .filter({ visible: true, hasText: filename });
    await sharedTab.hover();
    await sharedTab.locator(S.tabCloseButton).click();
    await b
      .getByTestId("collab-sidebar")
      .locator(S.fileTreeItem, { hasText: filename })
      .click();
    await expect.poll(() => gridRows(b)).toEqual(rows);
    expect(await serverRows(documentId)).toEqual(rows);
  } finally {
    await harness.stop();
  }
});
