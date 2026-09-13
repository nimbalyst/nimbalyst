// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SQLiteDatabase } from "../SQLiteDatabase";
import {
  captureCutoverVerification,
  verifyCutoverContent,
} from "../cutoverVerification";
import { verifyPendingCutover } from "../cutoverStartup";
import {
  getCutoverJournalPath,
  readCutoverJournal,
  writeCutoverJournal,
  fingerprintSource,
} from "../cutoverJournal";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

it("verifies reopened content and keeps the journal until repository startup acknowledges it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nim-cutover-startup-"));
  dirs.push(root);
  const target = path.join(root, "sqlite-db");
  const opts = {
    dbDir: target,
    schemaDir: path.resolve(__dirname, "../schemas"),
  };
  let db = new SQLiteDatabase(opts);
  await db.initialize();
  await db.query(
    "INSERT INTO ai_sessions (id, provider, title) VALUES ('sample-session', 'test', 'saved title')"
  );
  const verification = captureCutoverVerification(db);
  await db.close();
  writeCutoverJournal(root, {
    version: 1,
    operationId: "test-adoption",
    operation: "adopt",
    phase: "backend_committed",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reconcileAttempts: 0,
    commitSetBy: "user-migration",
    commitBackend: "sqlite",
    source: {
      livePath: path.join(root, "pglite-db"),
      preservedPath: path.join(root, "preserved"),
      fingerprint: fingerprintSource(target),
    },
    target: { livePath: target },
    rollback: { backendBefore: "pglite", stateBefore: null },
    verification,
  });
  db = new SQLiteDatabase(opts);
  await db.initialize();
  try {
    const verify = async (receipt: typeof verification | undefined) =>
      verifyCutoverContent(db, receipt);
    const acknowledge = await verifyPendingCutover({
      userDataPath: root,
      backend: "sqlite",
      verify,
      emitOutcome: vi.fn(),
    });
    expect(readCutoverJournal(root)?.phase).toBe("backend_committed");
    // A startup exception before acknowledgement must leave the record.
    await db.query(
      "UPDATE ai_sessions SET title = 'changed' WHERE id = 'sample-session'"
    );
    await expect(
      verifyPendingCutover({
        userDataPath: root,
        backend: "sqlite",
        verify,
        emitOutcome: vi.fn(),
      })
    ).rejects.toThrow(/verification failed/);
    expect(readCutoverJournal(root)?.phase).toBe("backend_committed");
    await db.query(
      "UPDATE ai_sessions SET title = 'saved title' WHERE id = 'sample-session'"
    );
    acknowledge();
    expect(readCutoverJournal(root)).toBeNull();
    await verifyPendingCutover({
      userDataPath: root,
      backend: "sqlite",
      verify: vi.fn(() => {
        throw new Error("no pending cutover");
      }),
      emitOutcome: vi.fn(),
    });
  } finally {
    await db.close();
  }
});

// The reconciler holds on an unreadable journal without touching anything and
// a healthy install boots. Throwing here instead sent that install to the
// recovery dialog over a file that merely could not be parsed.
it("starts without verification when the journal cannot be parsed, and leaves it in place", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nim-cutover-startup-"));
  dirs.push(root);
  fs.writeFileSync(getCutoverJournalPath(root), "{ not json");
  const verify = vi.fn();
  const warn = vi.fn();
  const acknowledge = await verifyPendingCutover({
    userDataPath: root,
    backend: "sqlite",
    verify,
    emitOutcome: vi.fn(),
    warn,
  });
  expect(verify).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  acknowledge();
  expect(fs.readFileSync(getCutoverJournalPath(root), "utf8")).toBe("{ not json");
});
