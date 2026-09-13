// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("../../shellEnvironment", () => ({ getEnhancedPath: vi.fn() }));
vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn() } },
}));
import { execFile } from "child_process";
import { getEnhancedPath } from "../../shellEnvironment";
import { logger } from "../../../utils/logger";
import { runWrangler, resolveWranglerModulePath } from "../wranglerCli";
import { toSandboxError } from "../errors";
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
it("uses the desktop enhanced PATH installation and keeps CLI diagnostics out of logs", async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "cf-cli-")));
  await mkdir(join(dir, "node_modules/wrangler/wrangler-dist"), {
    recursive: true,
  });
  await writeFile(join(dir, "wrangler"), "npm shim");
  await writeFile(
    join(dir, "node_modules/wrangler/package.json"),
    JSON.stringify({ name: "wrangler", main: "wrangler-dist/cli.js" })
  );
  await writeFile(join(dir, "node_modules/wrangler/wrangler-dist/cli.js"), "");
  vi.mocked(getEnhancedPath).mockReturnValue(dir);
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as Function;
    callback(
      new Error("not authenticated: synthetic-secret-value"),
      "",
      "Bearer synthetic-secret-value"
    );
    return {} as never;
  });
  const modulePath = await resolveWranglerModulePath();
  expect(modulePath).toBe(
    join(dir, "node_modules/wrangler/wrangler-dist/cli.js")
  );
  const response = await runWrangler(["--version"], { cwd: dir }).catch(
    (error) => toSandboxError(error)
  );
  expect(response).toMatchObject({
    code: "not-authenticated",
    message: expect.any(String),
  });
  expect(JSON.stringify(response)).not.toContain("synthetic-secret-value");
  expect(logger.main.warn).toHaveBeenCalledOnce();
  const [executable, args, options, callback] = vi
    .mocked(execFile)
    .mock.calls.at(-1)!;
  expect(executable).toBe(process.execPath);
  expect(args).toEqual([
    "-e",
    'process.defaultApp = true; require("node:module").runMain();',
    modulePath,
    "--version",
  ]);
  expect(options?.env?.PATH).toBe(dir);
  expect(options?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(options?.env?.WRANGLER_HIDE_BANNER).toBe("true");
  expect(typeof callback).toBe("function");
  expect(vi.mocked(logger.main.warn).mock.calls.flat().join(" ")).not.toContain(
    "synthetic-secret-value"
  );
});
