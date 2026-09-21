// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, statSync: vi.fn(original.statSync) };
});
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { directoryDeviceId } from "../directoryDeviceIdentity";
import { asPersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";
const account = asPersonalMemberId("account");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.statSync).mockReset();
  vi.mocked(fs.statSync).mockImplementation(require("node:fs").statSync);
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function root() {
  const dir = mkdtempSync(join(tmpdir(), "computer-id-"));
  roots.push(dir);
  return dir;
}

it("pins the shipped v1 derivation, including bigint filesystem identifiers", () => {
  const dir = root();
  writeFileSync(join(dir, "computer-identity"), "12345678-1234-4234-8234-123456789abc");
  const stat = vi.spyOn(fs, "statSync");
  stat.mockReturnValue({ dev: 16777234n, ino: 12345n } as fs.BigIntStats);
  expect(directoryDeviceId(dir, account)).toBe("7d28db8231d38b0b64bf37c2c830745a");
  stat.mockReturnValue({ dev: 16777234n, ino: 9007199254740993n } as fs.BigIntStats);
  expect(directoryDeviceId(dir, account)).toBe("dd03be89aba367f9072926c7d3ed7c4c");
  expect(directoryDeviceId(dir, asPersonalMemberId("other-account"))).not.toBe(directoryDeviceId(dir, account));
  stat.mockReturnValue({ dev: 16777235n, ino: 9007199254740993n } as fs.BigIntStats);
  expect(directoryDeviceId(dir, account)).not.toBe("dd03be89aba367f9072926c7d3ed7c4c");
});

it("shares identity through symlinks and directory moves, but separates copied profiles", () => {
  const base = root();
  const original = join(base, "original");
  const first = directoryDeviceId(original, account);
  symlinkSync(original, join(base, "alias"), "dir");
  expect(directoryDeviceId(join(base, "alias"), account)).toBe(first);
  cpSync(original, join(base, "copy"), { recursive: true });
  expect(directoryDeviceId(join(base, "copy"), account)).not.toBe(first);
  renameSync(original, join(base, "moved"));
  expect(directoryDeviceId(join(base, "moved"), account)).toBe(first);
  writeFileSync(join(base, "moved", "computer-identity"), "broken");
  expect(() => directoryDeviceId(join(base, "moved"), account)).toThrow(
    "restore"
  );
  expect(readFileSync(join(base, "moved", "computer-identity"), "utf8")).toBe(
    "broken"
  );
});

it("publishes one complete identity across concurrent fresh processes", async () => {
  const dir = root();
  const moduleUrl = new URL(
    `file://${resolve(
      "packages/electron/src/main/services/sync/directoryDeviceIdentity.ts"
    )}`
  ).href;
  const code = `import {directoryDeviceId} from ${JSON.stringify(
    moduleUrl
  )}; process.stdout.write(directoryDeviceId(process.argv[1], 'account'));`;
  const runs = await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        code,
        dir,
      ])
    )
  );
  expect(new Set(runs.map((r) => r.stdout)).size).toBe(1);
  expect(runs[0].stdout).toBe(directoryDeviceId(dir, account));
});

it("preserves an existing profile across release locations, channels, hostnames, and fresh processes", async () => {
  const base = root();
  const profile = join(base, "profile");
  const expected = directoryDeviceId(profile, account);
  const seed = readFileSync(join(profile, "computer-identity"), "utf8");
  const source = resolve("packages/electron/src/main/services/sync/directoryDeviceIdentity.ts");
  for (const [version, channel, hostname] of [
    ["0.78.1", "stable", "original-host"],
    ["0.79.0", "alpha", "renamed-host"],
  ]) {
    const installation = join(base, version);
    mkdirSync(installation);
    const installedModule = join(installation, "identity.ts");
    cpSync(source, installedModule);
    const code = `
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      os.hostname = () => ${JSON.stringify(hostname)};
      syncBuiltinESMExports();
      process.title = ${JSON.stringify(`Nimbalyst ${version} ${channel}`)};
      const { directoryDeviceId } = await import(${JSON.stringify(new URL(`file://${installedModule}`).href)});
      process.stdout.write(directoryDeviceId(process.argv[1], 'account'));
    `;
    const result = await promisify(execFile)(process.execPath, [
      "--experimental-strip-types", "--input-type=module", "-e", code, profile,
    ], { cwd: installation });
    expect(result.stdout).toBe(expected);
    expect(readFileSync(join(profile, "computer-identity"), "utf8")).toBe(seed);
  }
});
