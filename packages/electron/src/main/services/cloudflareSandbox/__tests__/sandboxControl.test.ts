// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { spawn } from "child_process";
import { app } from "electron";
import { registerCloudflareSandboxHandlers } from "../../../ipc/CloudflareSandboxHandlers";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("electron", () => ({ app: { on: vi.fn() } }));
vi.mock("../../../utils/ipcRegistry", () => ({ safeHandle: vi.fn() }));
vi.mock("../CloudflareSandboxService", () => ({
  getCloudflareSandboxService: vi.fn(),
}));

vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import {
  ChildProcessControlClient,
  killInFlightHelpers,
  parseHelperResponse,
  parseNodeStatusResponse,
  toContainerState,
  type SandboxControlTarget,
} from "../sandboxControl";
import { SandboxOperationError } from "../errors";

const TARGET: SandboxControlTarget = {
  cwd: "/n/profiles/work",
  configPath: "/n/control/wrangler.json",
  helperPath: "/n/artifact/rpc-helper.mjs",
  wranglerModulePath: "/usr/lib/wrangler/wrangler-dist/cli.js",
};

const OK = {
  success: true,
  data: {
    sandboxId: "personal",
    state: "running",
    lastChangedAt: 1,
    sleepAfterSeconds: 300,
    persistence: "ephemeral",
  },
};

const NODE_OK = { success: true, data: { ...OK.data, node: {
  running: true, processId: 'node-1', startedAt: 123, exitCode: null, recentLog: 'ready',
} } };

it('passes node requests through stdin payloads and requires a complete node response', async () => {
  const run = vi.fn(async () => NODE_OK);
  const client = new ChildProcessControlClient(run);
  const provision = { files: [{ path: '/home/nimbalyst/config', content: 'credential-secret' }], allowedHosts: ['github.com'] };
  expect(await client.provision(TARGET, provision)).toEqual(NODE_OK.data);
  expect(await client.startNode(TARGET, { configPath: '/home/nimbalyst/config' })).toEqual(NODE_OK.data);
  expect(await client.nodeStatus(TARGET)).toEqual(NODE_OK.data);
  expect(await client.stopNode(TARGET, { discardEphemeralData: true })).toEqual(NODE_OK.data);
  expect(run.mock.calls.map(call => (call as unknown[])[1])).toEqual([
    { wranglerModulePath: TARGET.wranglerModulePath, configPath: TARGET.configPath, operation: 'provision', request: provision },
    { wranglerModulePath: TARGET.wranglerModulePath, configPath: TARGET.configPath, operation: 'startNode', request: { configPath: '/home/nimbalyst/config' } },
    { wranglerModulePath: TARGET.wranglerModulePath, configPath: TARGET.configPath, operation: 'nodeStatus' },
    { wranglerModulePath: TARGET.wranglerModulePath, configPath: TARGET.configPath, operation: 'stopNode', request: { discardEphemeralData: true } },
  ]);
  expect(() => client.stopNode(TARGET, {} as never)).toThrow(SandboxOperationError);
  expect(run).toHaveBeenCalledTimes(4);
});

it('strictly rejects malformed or inconsistent node status fields', () => {
  for (const node of [undefined, null, [], {},
    ...Object.entries({ running: 'true', processId: 123, startedAt: '123', exitCode: 1.5, recentLog: null }).map(([key, value]) => ({ ...NODE_OK.data.node, [key]: value })),
    { ...NODE_OK.data.node, processId: null },
    { ...NODE_OK.data.node, exitCode: 0 },
    { ...NODE_OK.data.node, recentLog: 'x'.repeat(5000) },
  ]) expect(() => parseNodeStatusResponse({ success: true, data: { ...NODE_OK.data, node } })).toThrow(SandboxOperationError);
  for (const change of [{ sandboxId: 'other' }, { state: 'stopped' }, { persistence: 'durable' }, { lastChangedAt: NaN }, { sleepAfterSeconds: -1 }]) {
    expect(() => parseNodeStatusResponse({ success: true, data: { ...NODE_OK.data, ...change } })).toThrow(SandboxOperationError);
  }
  for (const code of ['node-not-provisioned', 'node-start-failed', 'grant-failed']) {
    expect(() => parseNodeStatusResponse({ success: false, error: code, reason: code })).toThrow(expect.objectContaining({ sandboxErrorCode: code }));
  }
});

it('measures replacement-character logs in UTF-8 bytes at the Worker limit', () => {
  const invalid = new TextDecoder().decode(new Uint8Array([0xff]));
  const recentLog = invalid.repeat(1365) + 'x';
  expect(Buffer.byteLength(recentLog)).toBe(4096);
  const frame = { success: true, data: { ...NODE_OK.data, node: { ...NODE_OK.data.node, recentLog } } };
  expect(parseNodeStatusResponse(frame).node.recentLog).toBe(recentLog);
  expect(() => parseNodeStatusResponse({ success: true, data: { ...frame.data, node: { ...frame.data.node, recentLog: recentLog + 'x' } } })).toThrow(SandboxOperationError);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeHelper(pid: number | undefined) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(),
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
  vi.mocked(spawn).mockReturnValueOnce(
    child as unknown as ReturnType<typeof spawn>
  );
  return child;
}

it("registers helper cleanup on Electron will-quit", () => {
  registerCloudflareSandboxHandlers();
  expect(app.on).toHaveBeenCalledWith("will-quit", killInFlightHelpers);
});

it("quit cleanup signals every in-flight group, but excludes closed helpers", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const children = [43211, 43212, 43213].map((pid) => {
    const child = fakeHelper(pid);
    const result = new ChildProcessControlClient()
      .status(TARGET)
      .catch(() => undefined);
    return { child, result };
  });
  children[0].child.emit("close", 1);
  try {
    killInFlightHelpers();
    killInFlightHelpers();
    expect(kill.mock.calls).toEqual([
      [-43212, "SIGKILL"],
      [-43213, "SIGKILL"],
    ]);
  } finally {
    for (const { child } of children) child.emit("close", 1);
    await Promise.all(children.map(({ result }) => result));
  }
});

it("does not signal a reused pid after exit while stdout is still open", async () => {
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const child = fakeHelper(43214);
  const result = new ChildProcessControlClient(undefined, 90_000).status(
    TARGET
  );
  const rejection = expect(result).rejects.toMatchObject({
    event: "helper-timeout",
  });
  child.emit("exit", 0);
  killInFlightHelpers();
  await vi.advanceTimersByTimeAsync(90_000);
  await rejection;
  child.emit("close", 0);
  expect(kill).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});

it.each([0, -1, undefined])(
  "never signals a process group for invalid pid %s",
  async (pid) => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = fakeHelper(pid);
    const result = new ChildProcessControlClient(undefined, 1).status(TARGET);
    const rejection = expect(result).rejects.toMatchObject({
      event: "helper-timeout",
    });
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    child.emit("close", 1);
    expect(kill).not.toHaveBeenCalled();
  }
);

describe.each(["linux", "darwin", "win32"])(
  "helper process cleanup on %s",
  (platform) => {
    it.each(["timeout", "overflow", "input"])(
      "terminates once on %s with platform-appropriate scope",
      async (reason) => {
        vi.useFakeTimers();
        vi.spyOn(process, "platform", "get").mockReturnValue(
          platform as NodeJS.Platform
        );
        const killGroup = vi.spyOn(process, "kill").mockReturnValue(true);
        const child = Object.assign(new EventEmitter(), {
          pid: 43210,
          kill: vi.fn(),
          stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
          stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        });
        vi.mocked(spawn).mockReturnValue(
          child as unknown as ReturnType<typeof spawn>
        );
        const result = new ChildProcessControlClient(undefined, 90_000).status(
          TARGET
        );
        const rejection = expect(result).rejects.toMatchObject({
          event: `helper-${reason}`,
        });

        await vi.advanceTimersByTimeAsync(89_999);
        expect(killGroup).not.toHaveBeenCalled();
        expect(child.kill).not.toHaveBeenCalled();
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(1);
        else if (reason === "overflow")
          child.stdout.emit("data", "x".repeat(64 * 1024 + 1));
        else child.stdin.emit("error", new Error("synthetic-input-failure"));
        await rejection;

        // Late stream events must not signal a process group whose pid may be reused.
        child.stdout.emit("data", "x".repeat(64 * 1024 + 1));
        child.stdin.emit("error", new Error("late-input-failure"));
        child.emit("close", 1);
        await vi.advanceTimersByTimeAsync(90_000);

        expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.detached).toBe(
          platform !== "win32"
        );
        if (platform === "win32") {
          expect(child.kill.mock.calls).toEqual([["SIGKILL"]]);
          expect(killGroup).not.toHaveBeenCalled();
        } else {
          expect(killGroup.mock.calls).toEqual([[-child.pid, "SIGKILL"]]);
          expect(child.kill).not.toHaveBeenCalled();
        }
        expect(vi.getTimerCount()).toBe(0);
      }
    );
  }
);

describe("ChildProcessControlClient", () => {
  it("runs the helper in the verified profile directory, which is how the account is selected", async () => {
    const run = vi.fn(async () => OK);
    await new ChildProcessControlClient(run).status(TARGET);

    const [target] = run.mock.calls[0] as unknown as [SandboxControlTarget];
    expect(target.cwd).toBe("/n/profiles/work");
  });

  it("passes the explicit control config and wrangler module to the helper", async () => {
    const run = vi.fn(async () => OK);
    await new ChildProcessControlClient(run).status(TARGET);

    const [, payload] = run.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>
    ];
    expect(payload).toMatchObject({
      operation: "status",
      configPath: "/n/control/wrangler.json",
      wranglerModulePath: "/usr/lib/wrangler/wrangler-dist/cli.js",
    });
  });

  it("forwards the discard consent to the worker rather than re-deciding it here", async () => {
    const run = vi.fn(async () => OK);
    await new ChildProcessControlClient(run).stop(TARGET, {
      discardEphemeralData: true,
    });

    const [, payload] = run.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>
    ];
    expect(payload).toMatchObject({
      operation: "stop",
      discardEphemeralData: true,
    });
  });

  it("refuses to stop without consent and never spawns the helper", async () => {
    const run = vi.fn(async () => OK);
    const client = new ChildProcessControlClient(run);

    expect(() =>
      client.stop(TARGET, { discardEphemeralData: false as unknown as true })
    ).toThrow(SandboxOperationError);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a helper failure envelope as an unreachable container", async () => {
    const run = vi.fn(async () => ({
      success: false,
      error: "container-unavailable",
    }));

    await expect(
      new ChildProcessControlClient(run).status(TARGET)
    ).rejects.toMatchObject({
      sandboxErrorCode: "container-unavailable",
    });
  });

  it("rejects a reply about a different sandbox instead of reporting it as ours", async () => {
    const run = vi.fn(async () => ({
      success: true,
      data: { ...OK.data, sandboxId: "someone-elses" },
    }));

    await expect(
      new ChildProcessControlClient(run).status(TARGET)
    ).rejects.toMatchObject({
      sandboxErrorCode: "container-unavailable",
    });
  });
});

describe("parseHelperResponse", () => {
  it("rejects an unparseable or truncated reply rather than inventing a state", () => {
    for (const bad of [
      null,
      {},
      { success: true },
      { success: true, data: {} },
    ]) {
      expect(() => parseHelperResponse(bad)).toThrow(SandboxOperationError);
    }
  });

  it("rejects a state the worker never promises", () => {
    expect(() =>
      parseHelperResponse({
        success: true,
        data: { sandboxId: "personal", state: "melted" },
      })
    ).toThrow(SandboxOperationError);
  });
});

describe("toContainerState", () => {
  it("treats healthy as running, because the UI has no separate healthy state", () => {
    const state = toContainerState({ ...OK.data, state: "healthy" } as never);

    expect(state.status).toBe("running");
  });

  it("explains a self-terminated container rather than showing a bare stopped", () => {
    const state = toContainerState({
      ...OK.data,
      state: "stopped_with_code",
    } as never);

    expect(state.status).toBe("stopped");
    expect(state.message).toMatch(/exited on its own/i);
  });
});
