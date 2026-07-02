import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { grepTailFile, tailFile } from "../logTail";

describe("grepTailFile", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "logtail-")),
      "main.log"
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("finds a match that lives far outside the recent-lines tail window (the grep-parity bug)", () => {
    // The needle is on line 1 of a 5000-line file. A tail-then-filter over
    // the last ~200 lines would never see it; grepTailFile must.
    const lines: string[] = ["[AI] NEEDLE_TOKEN happened here"];
    for (let i = 0; i < 5000; i++) {
      lines.push(`[MAIN] routine line ${i}`);
    }
    fs.writeFileSync(tmpFile, lines.join("\n") + "\n");

    const matches = grepTailFile(
      tmpFile,
      (line) => line.toLowerCase().includes("needle_token"),
      100
    );

    expect(matches).toEqual(["[AI] NEEDLE_TOKEN happened here"]);
  });

  it("returns only the last maxMatches matches, in file order", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`match ${i}`);
    }
    fs.writeFileSync(tmpFile, lines.join("\n") + "\n");

    const matches = grepTailFile(tmpFile, () => true, 3);

    expect(matches).toEqual(["match 7", "match 8", "match 9"]);
  });

  it("returns all matches when fewer than maxMatches exist", () => {
    fs.writeFileSync(tmpFile, ["a hit", "b miss", "c hit"].join("\n") + "\n");

    const matches = grepTailFile(tmpFile, (l) => l.includes("hit"), 100);

    expect(matches).toEqual(["a hit", "c hit"]);
  });

  it("handles a match on a line spanning a 1MB chunk boundary", () => {
    // Pad past 1MB so the reader crosses a chunk boundary, then place the
    // needle after the boundary to prove partial-line stitching works.
    const filler = "[MAIN] " + "x".repeat(200);
    const lines: string[] = [];
    let bytes = 0;
    while (bytes < 1024 * 1024 + 5000) {
      lines.push(filler);
      bytes += filler.length + 1;
    }
    lines.push("[AI] BOUNDARY_NEEDLE");
    fs.writeFileSync(tmpFile, lines.join("\n") + "\n");

    const matches = grepTailFile(
      tmpFile,
      (l) => l.includes("BOUNDARY_NEEDLE"),
      100
    );

    expect(matches).toEqual(["[AI] BOUNDARY_NEEDLE"]);
  });

  it("returns empty for an empty file or non-positive maxMatches", () => {
    fs.writeFileSync(tmpFile, "");
    expect(grepTailFile(tmpFile, () => true, 100)).toEqual([]);

    fs.writeFileSync(tmpFile, "something\n");
    expect(grepTailFile(tmpFile, () => true, 0)).toEqual([]);
  });
});

describe("tailFile", () => {
  it("returns the last N non-empty lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-"));
    const file = path.join(dir, "main.log");
    fs.writeFileSync(file, ["l1", "l2", "", "l3"].join("\n") + "\n");

    expect(tailFile(file, 2)).toEqual(["l2", "l3"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
