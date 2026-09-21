// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonl, validateSourcePath, contentMarkerAt } from "../jsonlReader";
import type { ExternalCursor } from "../types";
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-jsonl-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

it("commits only complete lines, retaining partial UTF8 and bounded unread data", async () => {
  const file = path.join(dir, "log.jsonl");
  const first = '{"uuid":"1"}\n';
  const second = Buffer.from('{"uuid":"2","text":"猫"}\n');
  await fs.writeFile(
    file,
    Buffer.concat([Buffer.from(first), second.subarray(0, second.length - 4)])
  );
  const a = await readJsonl(file, null, {
    maxReadBytes: 16,
    maxLineBytes: 128,
  });
  expect(a.entries.map((e) => e.value)).toEqual([{ uuid: "1" }]);
  expect(a.cursor.byteOffset).toBe(Buffer.byteLength(first));
  const b = await readJsonl(file, a.cursor, {
    maxReadBytes: 16,
    maxLineBytes: 128,
  });
  expect(b.entries).toEqual([]);
  expect(b.hasMore).toBe(false);
  expect(b.cursor.byteOffset).toBe(a.cursor.byteOffset);
  await fs.appendFile(file, second.subarray(second.length - 4));
  const c = await readJsonl(file, b.cursor, {
    maxReadBytes: 16,
    maxLineBytes: 128,
  });
  expect(c.entries.map((e) => e.value)).toEqual([{ uuid: "2", text: "猫" }]);
  expect(c.cursor.byteOffset).toBe(Buffer.byteLength(first) + second.length);
});

it("resets for truncation and inode replacement and preserves stable entry identities", async () => {
  const file = path.join(dir, "log.jsonl");
  const line = '{"uuid":"same","text":"first"}\n';
  await fs.writeFile(file, line + '{"text":"later"}\n');
  const a = await readJsonl(file, null);
  await fs.writeFile(file, line);
  const b = await readJsonl(file, a.cursor);
  expect(b.reset).toBe(true);
  expect(b.entries[0].entryId).toBe(a.entries[0].entryId);
  await fs.rename(file, file + ".old");
  await fs.writeFile(file, line);
  const c = await readJsonl(file, b.cursor);
  expect(c.reset).toBe(true);
  expect(c.entries[0].entryId).toBe(a.entries[0].entryId);
});

it("bounds lines and batches without advancing past oversized or incomplete records", async () => {
  const file = path.join(dir, "log.jsonl");
  await fs.writeFile(file, '{"a":1}\n'.repeat(20));
  const page = await readJsonl(file, null, {
    maxReadBytes: 16,
    maxLineBytes: 32,
  });
  expect(page.entries).toHaveLength(2);
  expect(page.cursor.byteOffset).toBe(16);
  expect(page.hasMore).toBe(true);
  await fs.writeFile(file, "x".repeat(100));
  await expect(
    readJsonl(file, null, { maxReadBytes: 16, maxLineBytes: 32 })
  ).rejects.toThrow("line exceeds");
  await fs.writeFile(file, 'broken\n{"ok":true}\n{"tail":');
  const valid = await readJsonl(file, null);
  expect(valid.entries.map((e) => e.value)).toEqual([{ ok: true }]);
  expect(valid.cursor.byteOffset).toBe(19);
  expect(valid.hasMore).toBe(false);
});

it("rejects nonabsolute source references even when they resolve to a valid file", async () => {
  const file = path.join(dir, "log.jsonl");
  await fs.writeFile(file, "{}\n");
  await expect(
    validateSourcePath(dir, path.relative(process.cwd(), file))
  ).rejects.toThrow("absolute");
});

it("flushes only valid manual EOF JSON without committing its incomplete-line cursor", async () => {
  const file = path.join(dir, "manual.jsonl");
  await fs.writeFile(file, '{"uuid":"final","text":"猫"}');
  expect((await readJsonl(file, null)).entries).toEqual([]);
  const manual = await readJsonl(file, null, { includeFinalLine: true });
  expect(manual.entries.map((e) => e.value.uuid)).toEqual(["final"]);
  expect(manual.cursor.byteOffset).toBe(0);
  expect(manual.hasMore).toBe(false);
  await fs.appendFile(file, "\n");
  const live = await readJsonl(file, manual.cursor);
  expect(live.entries[0].entryId).toBe(manual.entries[0].entryId);
  expect(live.cursor.byteOffset).toBe((await fs.stat(file)).size);
  await fs.writeFile(file, '{"uuid":');
  expect(
    (await readJsonl(file, null, { includeFinalLine: true })).entries
  ).toEqual([]);
});

it("keeps fallback identities stable when a manually flushed EOF gains a CRLF terminator", async () => {
  const file = path.join(dir, "crlf.jsonl");
  await fs.writeFile(file, '{"text":"final"}');
  const manual = await readJsonl(file, null, { includeFinalLine: true });
  await fs.appendFile(file, "\r\n");
  const live = await readJsonl(file, manual.cursor);
  expect(live.entries[0].entryId).toBe(manual.entries[0].entryId);
});

it("skips invalid complete UTF8 lines and retains incomplete UTF8 tails", async () => {
  const file = path.join(dir, "invalid-utf8.jsonl");
  const tail = Buffer.from('{"text":"猫"}\n');
  const prefix = Buffer.concat([
    Buffer.from([0xff, 10]),
    Buffer.from('{"uuid":"good"}\n'),
  ]);
  await fs.writeFile(
    file,
    Buffer.concat([prefix, tail.subarray(0, tail.length - 4)])
  );
  const first = await readJsonl(file, null);
  expect(first.entries.map((e) => e.entryId)).toEqual(["good"]);
  expect(first.cursor.byteOffset).toBe(prefix.length);
  await fs.appendFile(file, tail.subarray(tail.length - 4));
  expect((await readJsonl(file, first.cursor)).entries[0].value.text).toBe(
    "猫"
  );
});

it("detects same-inode rewrite after regrowth at the durable byte boundary", async () => {
  const file = path.join(dir, "rewrite.jsonl");
  await fs.writeFile(file, '{"uuid":"old"}\nmalformed\n');
  const first = await readJsonl(file, null);
  await fs.writeFile(file, '{"uuid":"new"}\nmalformed\n{"uuid":"later"}\n');
  const next = await readJsonl(file, JSON.parse(JSON.stringify(first.cursor)));
  expect(next.cursor.inode).toBe(first.cursor.inode);
  expect(next.reset).toBe(true);
  expect(next.entries.map((e) => e.entryId)).toEqual(["new", "later"]);
});

it("markers cover malformed committed lines, exclude manual EOF tails and reject malformed markers", async () => {
  const file = path.join(dir, "marker.jsonl");
  const prefix = '{"uuid":"complete"}\nmalformed\n';
  await fs.writeFile(file, prefix + '{"uuid":"tail"}');
  const manual = await readJsonl(file, null, { includeFinalLine: true });
  expect(manual.cursor.contentMarker).toBe(
    await contentMarkerAt(file, Buffer.byteLength(prefix))
  );
  await fs.appendFile(file, "\n");
  const appended = await readJsonl(file, manual.cursor);
  expect(appended.reset).toBe(false);
  expect(appended.entries[0].entryId).toBe("tail");
  await expect(
    readJsonl(file, { ...appended.cursor, contentMarker: "" })
  ).rejects.toThrow("content marker");
  const legacy: ExternalCursor = { ...appended.cursor };
  delete legacy.contentMarker;
  expect((await readJsonl(file, legacy)).cursor.contentMarker).toMatch(
    /^[a-f0-9]{64}$/
  );
  await fs.writeFile(
    file,
    prefix.replace("malformed", "different") + '{"uuid":"tail"}\n'
  );
  expect((await readJsonl(file, manual.cursor)).reset).toBe(true);
});
