// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deserialize } from "node:v8";
import Database from "better-sqlite3";
import {
  historyBatchWriter,
  historyQuarantineCount,
} from "../historyMigrationRecovery";

describe("bounded history recovery transactions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(
      "CREATE TABLE document_history (id INTEGER PRIMARY KEY, content BLOB)"
    );
  });
  afterEach(() => db.close());
  const row = (id: number, bad = false) => ({
    id,
    workspace_id: "ws",
    file_path: `${id}.md`,
    content: bad ? null : Buffer.from([0, 255]),
    timestamp: id,
    metadata: "{}",
  });
  const insert = (value: Record<string, unknown>) =>
    db
      .prepare("INSERT INTO document_history VALUES (?, ?)")
      .run(value.id, value.content);

  it.each([null, undefined, "invalid-json-text"])("normalizes present metadata %s without omissions or source mutation", metadata => {
    const original = { ...row(1), metadata };
    const normalized = { ...original, metadata: metadata == null ? "{}" : JSON.stringify(metadata) };
    const inserted: Record<string, unknown>[] = [];
    const accepted = historyBatchWriter(db, 1, value => { insert(value); inserted.push(value); })([original]);
    expect(inserted).toEqual([normalized]);
    expect(accepted).toEqual([normalized]);
    expect(original.metadata).toBe(metadata);
    expect(historyQuarantineCount(db)).toBe(0);
  });

  it("retains original metadata when another defect requires quarantine", () => {
    const original = { ...row(1, true), metadata: null };
    const repaired = { ...row(2), metadata: "invalid-json-text" };
    const accepted = historyBatchWriter(db, 100, insert)([original, repaired]);
    expect(accepted).toEqual([{ ...repaired, metadata: JSON.stringify(repaired.metadata) }]);
    expect(repaired.metadata).toBe("invalid-json-text");
    const saved = db.prepare("SELECT source_row FROM migration_history_quarantine").get() as { source_row: Buffer };
    expect(deserialize(saved.source_row)).toEqual(original);
  });

  it.each([NaN, Infinity, -1, 1.5])("rejects an invalid source count %s", count => {
    expect(() => historyBatchWriter(db, count, insert)).toThrow(/Invalid source history row count/);
  });

  it("rechecks existing omissions when the source shrinks", () => {
    historyBatchWriter(db, 100, insert)([row(1, true)]);
    expect(() => historyBatchWriter(db, 99, insert)).toThrow(/limit exceeded/);
  });

  it("does not exceed the absolute cap even when one percent permits more", () => {
    const write = historyBatchWriter(db, 20_000, insert);
    expect(() =>
      write(Array.from({ length: 101 }, (_, i) => row(i + 1, true)))
    ).toThrow(/limit exceeded/);
    expect(historyQuarantineCount(db)).toBe(0);
  });

  it("does not omit even one row when it would exceed one percent", () => {
    expect(() =>
      historyBatchWriter(db, 99, insert)([row(1), row(2, true)])
    ).toThrow(/limit exceeded/);
    expect(
      db.prepare("SELECT count(*) AS n FROM document_history").get()
    ).toEqual({ n: 0 });
  });

  it.each([
    "SQLITE_IOERR",
    "SQLITE_FULL",
    "SQLITE_CORRUPT",
    "SQLITE_BUSY",
    "SQLITE_ERROR",
    "SQLITE_CONSTRAINT_UNIQUE",
    "SQLITE_CONSTRAINT_FOREIGNKEY",
    "SQLITE_CONSTRAINT_CHECK",
  ])("keeps %s fatal even after isolating a bad row", (code) => {
    const failure = Object.assign(new Error("injected engine failure"), {
      code,
    });
    const write = historyBatchWriter(db, 100, (value) => {
      if (value.id === 3) throw failure;
      insert(value);
    });
    expect(() => write([row(1), row(2, true), row(3)])).toThrow(failure);
    expect(historyQuarantineCount(db)).toBe(0);
    expect(
      db.prepare("SELECT count(*) AS n FROM document_history").get()
    ).toEqual({ n: 0 });
  });

  it("aborts if saving the quarantine record fails", () => {
    const write = historyBatchWriter(db, 200, insert);
    write([row(1, true)]);
    db.exec(
      "CREATE TRIGGER fail_quarantine BEFORE INSERT ON migration_history_quarantine BEGIN SELECT RAISE(ABORT, 'quarantine write failed'); END"
    );
    expect(() => write([row(2), row(3, true)])).toThrow(
      "quarantine write failed"
    );
    expect(historyQuarantineCount(db)).toBe(1);
    expect(
      db.prepare("SELECT count(*) AS n FROM document_history").get()
    ).toEqual({ n: 0 });
  });

  it("does not classify schema mismatches or unexpected conversion exceptions as row defects", () => {
    const { metadata: _, ...missingColumn } = row(1);
    expect(() => historyBatchWriter(db, 100, insert)([missingColumn])).toThrow(
      /Missing.*column/
    );
    const failure = new TypeError("unexpected translator bug");
    expect(() =>
      historyBatchWriter(db, 100, () => {
        throw failure;
      })([row(1)])
    ).toThrow(failure);
    expect(historyQuarantineCount(db)).toBe(0);
  });
});
