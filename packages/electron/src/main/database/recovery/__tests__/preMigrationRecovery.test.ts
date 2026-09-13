// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../utils/logger", () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  preserveCutoverJournalEvidence,
  recordedPreMigrationSource,
  recoverPreMigrationDatabase,
  restoreWithCutoverJournalEvidence,
} from "../preMigrationRecovery";
import {
  readBackendState,
  writeBackendState,
} from "../../sqlite/BackendSelector";
import {
  fingerprintSource,
  fingerprintsMatch,
  getCutoverJournalPath,
  readCutoverJournal,
  writeCutoverJournal,
  type CutoverSourceFingerprint,
} from "../../sqlite/cutoverJournal";
import { logger } from "../../../utils/logger";

const dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function install() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nim-startup-rollback-"));
  dirs.push(root);
  const source = path.join(root, "pglite-db.migrated-recorded");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "PG_VERSION"), "17");
  fs.mkdirSync(path.join(root, "sqlite-db"));
  fs.writeFileSync(
    path.join(root, "sqlite-db", "nimbalyst.sqlite"),
    "newer user data"
  );
  writeBackendState(root, {
    backend: "sqlite",
    setBy: "user-migration",
    setAt: new Date().toISOString(),
    pgliteMigratedDir: source,
  });
  return root;
}
function writeJournal(
  root: string,
  preservedPath: string,
  fingerprint: CutoverSourceFingerprint = fingerprintSource(preservedPath)
) {
  writeCutoverJournal(root, {
    version: 1,
    operationId: "op-test",
    operation: "migrate",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "backend_committed",
    reconcileAttempts: 0,
    source: {
      livePath: path.join(root, "pglite-db"),
      preservedPath,
      fingerprint,
    },
    commitSetBy: "user-migration",
    target: { livePath: path.join(root, "sqlite-db") },
    rollback: { backendBefore: "pglite", stateBefore: null },
  });
}
const evidenceCopies = (root: string) =>
  fs.readdirSync(root).filter((n) => n.includes(".recovered-"));
const healthy = async () => ({
  valid: true,
  requiredSchemaPresent: true,
  integrity: "not-applicable" as const,
  indicators: { sessionCount: 1, documentHistoryCount: 1, projectCount: 1 },
});
const unverifiable = async () => ({
  valid: false,
  requiredSchemaPresent: false,
  integrity: "unreadable" as const,
  indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
});

it("verifies the recorded source, closes the current database, preserves the newer SQLite store, and keeps the forward journal as evidence", async () => {
  const root = install();
  const source = recordedPreMigrationSource(root)!;
  writeJournal(root, source.path);
  const order: string[] = [];
  await recoverPreMigrationDatabase({
    userDataPath: root,
    source,
    verify: async (p) => {
      expect(p).toBe(source.path);
      order.push("verify");
      return healthy();
    },
    closeDatabase: async () => {
      order.push("close");
      expect(fs.existsSync(source.path)).toBe(true);
    },
  });
  expect(order).toEqual(["verify", "close"]);
  expect(readBackendState(root)?.backend).toBe("pglite");
  // The rollback's own journal replaced the forward one; the forward record
  // survives as a copy rather than being renamed out from under startup.
  const journal = readCutoverJournal(root)!;
  expect(journal.operation).toBe("rollback");
  expect(journal.phase).toBe("backend_committed");
  const copies = evidenceCopies(root);
  expect(copies).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(root, copies[0]), "utf8")).operation).toBe("migrate");
  expect(
    fs.readFileSync(
      path.join(journal.source.preservedPath, "nimbalyst.sqlite"),
      "utf8"
    )
  ).toBe("newer user data");
  expect(
    fs.readFileSync(path.join(root, "pglite-db", "PG_VERSION"), "utf8")
  ).toBe("17");
});
it("leaves all paths and the backend unchanged when source verification fails", async () => {
  const root = install();
  const closeDatabase = vi.fn();
  await expect(
    recoverPreMigrationDatabase({
      userDataPath: root,
      source: recordedPreMigrationSource(root)!,
      closeDatabase,
      verify: unverifiable,
    })
  ).rejects.toThrow(/could not be verified/);
  expect(closeDatabase).not.toHaveBeenCalled();
  expect(readBackendState(root)?.backend).toBe("sqlite");
  expect(recordedPreMigrationSource(root)).toBeDefined();
});

/**
 * A journal we cannot parse names no paths, so there is nothing it can
 * authorize. Falling back to the backend flag here would offer a one-click
 * rollback justified by a record nobody read, and moving it would destroy
 * the only evidence of the cutover that was running.
 */
it("offers no candidate and preserves nothing while the journal is unreadable", () => {
  const root = install();
  fs.writeFileSync(getCutoverJournalPath(root), "{ not json");

  expect(recordedPreMigrationSource(root)).toBeUndefined();
  expect(recordedPreMigrationSource(root)).toBeUndefined();
  // Once per install, not once per dialog build.
  expect(logger.main.warn).toHaveBeenCalledTimes(1);

  expect(preserveCutoverJournalEvidence(root)).toBeUndefined();
  expect(evidenceCopies(root)).toEqual([]);
  expect(fs.readFileSync(getCutoverJournalPath(root), "utf8")).toBe("{ not json");
});

it("refuses a source whose fingerprint no longer matches the journal, before opening it", async () => {
  const root = install();
  const source = recordedPreMigrationSource(root)!;
  writeJournal(root, source.path, {
    entryCount: 99,
    totalBytes: 99,
    newestMtimeMs: 0,
  });
  const verify = vi.fn();
  const closeDatabase = vi.fn();

  await expect(
    recoverPreMigrationDatabase({ userDataPath: root, source, verify, closeDatabase })
  ).rejects.toThrow(/does not match the recorded pre-migration source/);
  // The probe opens the directory, which moves its newest mtime. Checking
  // after it would compare the fingerprint against the act of checking.
  expect(verify).not.toHaveBeenCalled();
  expect(closeDatabase).not.toHaveBeenCalled();
  expect(readBackendState(root)?.backend).toBe("sqlite");

  // A journal that does match still reaches verification.
  writeJournal(root, source.path);
  await expect(
    recoverPreMigrationDatabase({
      userDataPath: root,
      source,
      closeDatabase,
      verify: vi.fn(unverifiable),
    })
  ).rejects.toThrow(/could not be verified/);
});

/**
 * The probe leaves a footprint on the preserved store. Without re-recording
 * the fingerprint after a successful probe, one attempt that failed later
 * (here: the live database would not close) would make every later attempt
 * refuse the same source for the probe's own writes.
 */
it("re-records the fingerprint after a successful probe so a failed attempt can be retried", async () => {
  const root = install();
  const source = recordedPreMigrationSource(root)!;
  writeJournal(root, source.path);
  const verify = vi.fn(async (p: string) => {
    fs.writeFileSync(path.join(p, "postmaster.pid"), "opened by the probe");
    return healthy();
  });

  await expect(
    recoverPreMigrationDatabase({
      userDataPath: root,
      source,
      verify,
      closeDatabase: async () => {
        throw new Error("worker would not close");
      },
    })
  ).rejects.toThrow(/would not close/);
  expect(
    fingerprintsMatch(fingerprintSource(source.path), readCutoverJournal(root)!.source.fingerprint)
  ).toBe(true);
  expect(readBackendState(root)?.backend).toBe("sqlite");

  await expect(
    recoverPreMigrationDatabase({
      userDataPath: root,
      source,
      verify: vi.fn(unverifiable),
      closeDatabase: vi.fn(),
    })
  ).rejects.toThrow(/could not be verified/);
});

/**
 * Ordering, because the journal is what makes startup verify the live store.
 * It must stay in place until the restore has replaced that store: renaming
 * it aside first left a crash window in which the next launch opened a
 * database that had just failed verification with nothing pending.
 */
it("keeps the journal in place while the restore runs and retires it only after success", async () => {
  const root = install();
  writeJournal(root, recordedPreMigrationSource(root)!.path);
  const file = getCutoverJournalPath(root);
  const original = fs.readFileSync(file, "utf8");
  let journalDuringRun = false;

  const outcome = await restoreWithCutoverJournalEvidence(root, async () => {
    journalDuringRun = fs.existsSync(file);
    return { ok: true };
  });

  expect(journalDuringRun).toBe(true);
  expect(outcome).toEqual({ ok: true });
  expect(fs.existsSync(file)).toBe(false);
  const copies = evidenceCopies(root);
  expect(copies).toHaveLength(1);
  expect(fs.readFileSync(path.join(root, copies[0]), "utf8")).toBe(original);
});

it("leaves the journal untouched when the restore fails, and will not restore when the evidence copy cannot be made", async () => {
  const root = install();
  writeJournal(root, recordedPreMigrationSource(root)!.path);
  const file = getCutoverJournalPath(root);
  const original = fs.readFileSync(file, "utf8");

  const failed = await restoreWithCutoverJournalEvidence(root, async () => ({
    ok: false,
    message: "candidate was empty",
    canTryAnother: true,
  }));
  expect(failed).toMatchObject({ ok: false, message: "candidate was empty", canTryAnother: true });
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(evidenceCopies(root)).toHaveLength(1);

  // Block the copy the way the filesystem can: its destination is already
  // taken by a directory. Windows file locks are the real-world shape, and
  // are not reproducible here.
  vi.spyOn(Date, "now").mockReturnValue(1234);
  fs.mkdirSync(`${file}.recovered-1234`);
  const run = vi.fn();
  const refused = await restoreWithCutoverJournalEvidence(root, run);
  expect(run).not.toHaveBeenCalled();
  expect(refused).toMatchObject({ ok: false, canTryAnother: false });
  expect(refused.message).toMatch(/[Nn]othing was moved/);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});
