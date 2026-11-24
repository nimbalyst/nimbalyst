// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const sessionRecords = vi.hoisted(() => new Map<string, { id: string; title?: string; parentSessionId?: string | null }>());

vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: {
    get: vi.fn(async (id: string) => sessionRecords.get(id) ?? null),
  },
}));

vi.mock("electron", async () => {
  const { EventEmitter: EE } = await import("node:events");
  let nextId = 1;
  class FakeContentView {
    children: unknown[] = [];
    addChildView(v: unknown): void {
      if (!this.children.includes(v)) this.children.push(v);
    }
    removeChildView(v: unknown): void {
      const i = this.children.indexOf(v);
      if (i >= 0) this.children.splice(i, 1);
    }
  }
  class FakeWindow extends EE {
    readonly id = nextId++;
    readonly contentView = new FakeContentView();
    readonly sent: Array<{ channel: string; payload: unknown }> = [];
    readonly webContents = {
      getZoomFactor: () => 1,
      send: (channel: string, payload: unknown) => this.sent.push({ channel, payload }),
    };
    private destroyed = false;
    private size: [number, number] = [1280, 900];
    isDestroyed(): boolean {
      return this.destroyed;
    }
    getContentSize(): [number, number] {
      return this.size;
    }
    setContentSize(w: number, h: number): void {
      this.size = [w, h];
    }
    getBounds() {
      return { x: 0, y: 0, width: this.size[0], height: this.size[1] };
    }
    showInactive(): void {}
    setOpacity(): void {}
    setIgnoreMouseEvents(): void {}
    setAlwaysOnTop(): void {}
    destroy(): void {
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit("closed");
      }
    }
  }
  class FakeView {
    bounds: unknown = null;
    loadedUrls: string[] = [];
    readonly webContents = {
      on: () => {},
      setWindowOpenHandler: () => {},
      loadURL: (u: string) => {
        this.loadedUrls.push(u);
        return Promise.resolve();
      },
      close: () => {},
      debugger: { isAttached: () => false, detach: () => {} },
    };
    setBounds(b: unknown): void {
      this.bounds = b;
    }
  }
  return {
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { fromPartition: () => ({}) },
  };
});

vi.mock("../../../utils/logger", () => ({
  logger: { main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock("../../../protocols/nimPreviewProtocol", () => ({
  ensureNimPreviewProtocolForSession: vi.fn(),
}));
vi.mock("../../../mediaPermissionGate", () => ({ installMicrophoneGate: vi.fn() }));

import { BrowserWindow } from "electron";
import { BrowserSessionService } from "../../../services/BrowserSessionService";
import {
  interceptAgentBrowserTool,
  resetAgentBrowserTabRegistryForTests,
} from "../agentBrowserTabs";

type MockWindow = BrowserWindow & { sent: Array<{ channel: string; payload: string }> };

function makeWindow(): MockWindow {
  return new BrowserWindow() as unknown as MockWindow;
}

describe("interceptAgentBrowserTool", () => {
  afterEach(() => {
    BrowserSessionService.__resetForTests();
    resetAgentBrowserTabRegistryForTests();
    sessionRecords.clear();
  });

  it("opens a background tab in the root workstream by default and resolves self-chosen aliases", async () => {
    sessionRecords.set("root-1", { id: "root-1", title: "Checkout flow", parentSessionId: null });
    sessionRecords.set("child-1", { id: "child-1", title: "PayPal step", parentSessionId: "root-1" });
    const win = makeWindow();

    const open = await interceptAgentBrowserTool(
      "browser.open_session",
      { url: "https://www.paypal.com/signin", sessionId: "paypal" },
      "child-1",
      "/ws",
      win,
    );

    expect(open?.handled).toBe(true);
    expect(win.sent).toHaveLength(1);
    const tabUrl = win.sent[0].payload;
    expect(tabUrl).toMatch(/^virtual:\/\/com\.nimbalyst\.browser\/agent-/);
    const qs = new URLSearchParams(tabUrl.split("?")[1]);
    expect(qs.get("agent")).toBe("1");
    expect(qs.get("session")).toBe("root-1");
    expect(qs.get("foreground")).toBeNull();
    expect(qs.get("title")).toContain("paypal.com");

    const click = await interceptAgentBrowserTool(
      "browser.click",
      { sessionId: "paypal", selector: "#btn" },
      "child-1",
      "/ws",
      win,
    );
    expect(click?.handled).toBe(false);
    if (click && !click.handled) {
      expect(String(click.rewrittenArgs.sessionId)).toMatch(/^browser-virtual:agent-/);
    }

    // Bringing existing alias to foreground without url keeps the page intact and reuses the canonical URL.
    const fg = await interceptAgentBrowserTool(
      "browser.open_session",
      { sessionId: "paypal", foreground: true },
      "child-1",
      "/ws",
      win,
    );
    expect(fg?.handled).toBe(true);
    expect(win.sent).toHaveLength(2);
    expect(win.sent[1].payload).toBe(`${tabUrl}&foreground=1`);

    // Closing cleans up alias mapping.
    const close = await interceptAgentBrowserTool(
      "browser.close_session",
      { sessionId: "paypal" },
      "child-1",
      "/ws",
      win,
    );
    expect(close?.handled).toBe(false);
    const afterClose = await interceptAgentBrowserTool(
      "browser.click",
      { sessionId: "paypal" },
      "child-1",
      "/ws",
      win,
    );
    expect(afterClose).toBeNull();
  });

  it("leaves explicit headless: true without foreground untouched", async () => {
    const win = makeWindow();
    const res = await interceptAgentBrowserTool(
      "browser.open_session",
      { url: "https://example.com", headless: true },
      "s1",
      "/ws",
      win,
    );
    expect(res).toBeNull();
    expect(win.sent).toHaveLength(0);
  });

  it("opens a foreground tab when headless: false is passed", async () => {
    const win = makeWindow();
    const res = await interceptAgentBrowserTool(
      "browser.open_session",
      { url: "https://example.com", headless: false },
      "s1",
      "/ws",
      win,
    );
    expect(res?.handled).toBe(true);
    expect(win.sent).toHaveLength(1);
    expect(win.sent[0].payload).toContain("foreground=1");
  });

  it("promotes a live headless session in-place on foreground: true without reloading", async () => {
    const svc = BrowserSessionService.getInstance();
    svc.createSession({ sessionId: "hl-1", url: "https://paypal.com/challenge", headless: true });
    const win = makeWindow();

    const res = await interceptAgentBrowserTool(
      "browser.open_session",
      { sessionId: "hl-1", foreground: true },
      "s1",
      "/ws",
      win,
    );
    expect(res?.handled).toBe(true);
    expect(win.sent).toHaveLength(1);
    const qs = new URLSearchParams(win.sent[0].payload.split("?")[1]);
    expect(qs.get("sid")).toBe("hl-1");
    expect(qs.get("foreground")).toBe("1");
  });
});
