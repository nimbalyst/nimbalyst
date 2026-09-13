// @vitest-environment node
/**
 * Spawns the real helper as a child process. Mocked transports cannot catch the
 * things that actually break here: the stdin protocol, the promise that
 * Wrangler's own diagnostics never reach stdout, and the bounded failure frame
 * on a non-zero exit.
 *
 * No network and no Cloudflare account: every case fails before the RPC, which
 * is exactly the surface worth pinning.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import {
  ChildProcessControlClient,
  type SandboxControlTarget,
} from "../sandboxControl";

const REPO_HELPER = path.resolve(
  __dirname,
  "../../../../../../cloudflare-sandbox/scripts/rpc-helper.mjs"
);

let dir: string;


async function target(config: unknown): Promise<SandboxControlTarget> {
  const configPath = path.join(dir, "wrangler.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(
    path.join(dir, "wrangler.mjs"),
    'export async function getPlatformProxy() { throw new Error("synthetic-rpc-failure"); }'
  );
  return {
    cwd: dir,
    configPath,
    helperPath: REPO_HELPER,
    // Local fake module keeps validation and RPC failures independent of credentials.
    wranglerModulePath: path.join(dir, "wrangler.mjs"),
  };
}

const VALID_CONFIG = {
  name: "nimbalyst-sandbox-abcdef123456-control",
  account_id: "a".repeat(32),
  compatibility_date: "2026-09-09",
  services: [
    {
      binding: "Manager",
      service: "nimbalyst-sandbox-abcdef123456",
      entrypoint: "SandboxManager",
      remote: true,
    },
  ],
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbalyst-helper-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("rpc-helper child process", () => {
  it(
    "reports a bounded failure, not a crash, when Wrangler cannot be loaded",
    async () => {
      const client = new ChildProcessControlClient(undefined, 30_000);

      await expect(
        client.status({
          ...(await target(VALID_CONFIG)),
          wranglerModulePath: path.join(dir, "missing.mjs"),
        })
      ).rejects.toMatchObject({
        sandboxErrorCode: "wrangler-unsupported",
      });
    }
  );

  it(
    "rejects a control config carrying container or durable-object bindings",
    async () => {
      const client = new ChildProcessControlClient(undefined, 30_000);

      // A control path that could provision resources is the thing this guard
      // exists to make impossible.
      await expect(
        client.status(
          await target({
            ...VALID_CONFIG,
            containers: [{ class_name: "NimbalystSandbox", image: "x" }],
          })
        )
      ).rejects.toMatchObject({
        sandboxErrorCode: "unknown",
        event: "helper-failure",
      });
    }
  );

  it(
    "rejects a config whose account id is not a real account id",
    async () => {
      const client = new ChildProcessControlClient(undefined, 30_000);

      await expect(
        client.status(
          await target({ ...VALID_CONFIG, account_id: "not-an-account" })
        )
      ).rejects.toMatchObject({
        sandboxErrorCode: "unknown",
        event: "helper-failure",
      });
    }
  );

  it(
    "never lets Wrangler diagnostics reach the protocol channel",
    async () => {
      let captured: unknown;
      const client = new ChildProcessControlClient(
        async (t, payload, timeoutMs) => {
          const { spawn } = await import("child_process");
          return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [t.helperPath], {
              cwd: t.cwd,
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CI: "1" },
              stdio: ["pipe", "pipe", "pipe"],
            });
            let out = "";
            child.stdout.on("data", (c) => (out += c));
            child.on("close", () => {
              captured = out;
              try {
                resolve(JSON.parse(out.trim().split("\n").pop() ?? ""));
              } catch {
                reject(new Error("unparseable"));
              }
            });
            child.stdin.end(JSON.stringify(payload));
            setTimeout(() => child.kill("SIGKILL"), timeoutMs).unref();
          });
        },
        30_000
      );

      await client.status(await target(VALID_CONFIG)).catch(() => undefined);

      // Exactly one JSON line, and nothing that looks like a credential or a URL.
      const text = String(captured ?? "");
      expect(text.trim().split("\n")).toHaveLength(1);
      expect(text).not.toMatch(/Authorization|Bearer|oauth|https?:\/\//i);
      expect(JSON.parse(text)).toMatchObject({ success: false });
    }
  );
});

it("rejects a success frame from a child that exits with failure", async () => {
  const helperPath = path.join(dir, "broken.mjs");
  await fs.writeFile(
    helperPath,
    `process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({ success:true, data:{sandboxId:'personal',state:'running',lastChangedAt:1,sleepAfterSeconds:300,persistence:'ephemeral'} })); process.exitCode=7; });`
  );
  const t = await target(VALID_CONFIG);
  await expect(
    new ChildProcessControlClient().status({ ...t, helperPath })
  ).rejects.toMatchObject({ sandboxErrorCode: "container-unavailable" });
});
