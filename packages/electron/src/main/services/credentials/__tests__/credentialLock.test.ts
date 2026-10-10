// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withCredentialLock } from "../credentialLock";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("acquires the lock when the other holder releases it between link and lstat", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-lock-"));
  dirs.push(dir);
  const lock = path.join(dir, ".provider-credentials.lock");
  fs.writeFileSync(lock, String(process.pid));

  const realLstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementationOnce(((target: fs.PathLike) => {
    // The holder finishes right after our link attempt saw EEXIST.
    fs.unlinkSync(lock);
    return realLstat(target);
  }) as typeof fs.lstatSync);

  expect(withCredentialLock(dir, () => "written")).toBe("written");
  expect(fs.existsSync(lock)).toBe(false);
});
