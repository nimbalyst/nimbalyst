// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { SQLiteDatabase } from "../../../database/sqlite/SQLiteDatabase";
import { createPGLiteSessionStore } from "../../PGLiteSessionStore";
import { ExternalSessionPersistence } from "../ExternalSessionPersistence";
import { ClaudeCodeSource } from "../ClaudeCodeSource";
import { CodexSource } from "../CodexSource";
import { encodeWorkspaceDir } from "../../ClaudeCodeSessionScanner";
import { TranscriptMigrationService } from "@nimbalyst/runtime/ai/server/transcript/TranscriptMigrationService";
import { TranscriptMigrationRepository } from "@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository";
import { createRawMessageStoreAdapter } from "../../TranscriptMigrationAdapters";
const fixtureDb = vi.hoisted(() => ({ current: null as any }));
vi.mock("../../../database/PGLiteDatabaseWorker", () => ({
  database: {
    isInitialized: () => true,
    query: (...args: any[]) => fixtureDb.current.query(...args),
  },
}));
import {
  ExternalSessionIngestor,
  hasPendingExternalOwnership,
  readLegacyExternalMessages,
} from "../ExternalSessionIngestor";
import type { ExternalSessionRef } from "../types";
import type { SessionStore } from "@nimbalyst/runtime/ai/adapters/sessionStore";

const ref: ExternalSessionRef = {
  providerId: "claude-code",
  externalId: "external",
  workspacePath: "/worktree",
  filePath: "/log",
  updatedAt: 1000,
};
function harness(maxPending = 256) {
  const session = {
    id: "local",
    provider: "claude-code",
    workspaceId: "/workspace",
    providerConfig: { imported: true } as { imported?: boolean },
    metadata: {},
    title: "User title",
    hasBeenNamed: false,
  };
  const sessions = {
    get: vi.fn(async (_id: string) => session),
    create: vi.fn<SessionStore["create"]>(),
    updateMetadata: vi.fn<SessionStore["updateMetadata"]>(),
  };
  const persistence = {
    resolveSessionId: vi.fn(async () => "local"),
    getCursor: vi.fn(async () => null),
    appendAndAdvance: vi.fn(),
  };
  const source: any = {
    providerId: "claude-code",
    readSince: vi.fn(async () => ({
      messages: [
        {
          sourceEntryId: "entry",
          direction: "input",
          content: '{"prompt":"hello"}',
          metadata: null,
          timestamp: "2026-09-14T12:00:00Z",
        },
      ],
      cursor: {
        byteOffset: 20,
        fileSize: 20,
        inode: 1,
        lastEntryUuid: "entry",
      },
      hasMore: false,
      reset: false,
    })),
  };
  const processNewMessages = vi.fn();
  const refresh = vi.fn();
  const state = vi.fn(() => null);
  const ingestor = new ExternalSessionIngestor(
    {
      sessions,
      persistence,
      processNewMessages,
      refresh,
      getSessionState: state,
    } as any,
    maxPending
  );
  return {
    ingestor,
    sessions,
    persistence,
    source,
    processNewMessages,
    refresh,
    state,
    session,
  };
}
describe("ExternalSessionIngestor", () => {
  it("recovers canonical delivery on unchanged polls without redundant persistence or refresh", async () => {
    const h = harness();
    const batch = { ...(await h.source.readSince()), messages: [] };
    h.source.readSince.mockResolvedValue(batch);
    h.persistence.getCursor.mockResolvedValue({ ...batch.cursor } as any);
    h.session.metadata = {
      externalSource: ref.providerId,
      externalLastActivityAt: ref.updatedAt,
    };
    h.processNewMessages.mockRejectedValueOnce(new Error("delivery failed"));
    await expect(
      h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" })
    ).rejects.toThrow("delivery failed");
    // The durable cursor survives restart even when canonical delivery did not.
    const restarted = new ExternalSessionIngestor({
      sessions: h.sessions,
      persistence: h.persistence,
      processNewMessages: h.processNewMessages,
      refresh: h.refresh,
      getSessionState: h.state,
    } as any);
    await restarted.ingest(h.source, ref, { workspacePath: "/workspace" });
    expect(h.processNewMessages).toHaveBeenCalledTimes(2);
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
    expect(h.sessions.updateMetadata).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("persists cursor-only progress without claiming a sidebar change", async () => {
    const h = harness();
    const batch = { ...(await h.source.readSince()), messages: [] };
    h.source.readSince.mockResolvedValue(batch);
    h.persistence.getCursor.mockResolvedValue({
      ...batch.cursor,
      byteOffset: 10,
    } as any);
    h.session.metadata = {
      externalSource: ref.providerId,
      externalLastActivityAt: ref.updatedAt,
    };
    await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
    expect(h.persistence.appendAndAdvance).toHaveBeenCalledTimes(1);
    expect(h.persistence.appendAndAdvance).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: batch.cursor,
        messages: [],
      })
    );
    expect(h.processNewMessages).toHaveBeenCalledTimes(1);
    expect(h.sessions.updateMetadata).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("writes only changed imported metadata and suppresses identical title/model polls", async () => {
    const h = harness();
    h.session.title = "CLI title";
    h.session.metadata = {
      externalSource: ref.providerId,
      externalLastActivityAt: ref.updatedAt,
      externalLastImportedTitle: "CLI title",
    };
    const batch = {
      ...(await h.source.readSince()),
      messages: [],
      title: "Later title",
      model: "new-model",
    };
    h.source.readSince.mockResolvedValue(batch);
    h.persistence.getCursor.mockResolvedValue({ ...batch.cursor } as any);
    h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
      Object.assign(h.session, {
        ...patch,
        metadata: { ...h.session.metadata, ...patch.metadata },
      });
    });
    await h.ingestor.ingest(
      h.source,
      { ...ref, updatedAt: 2000 },
      { workspacePath: "/workspace" }
    );
    expect(h.sessions.updateMetadata).toHaveBeenCalledExactlyOnceWith("local", {
      metadata: {
        externalLastActivityAt: 2000,
        externalLastImportedTitle: "Later title",
        externalLastImportedTitleKind: "generated",
      },
      title: "Later title",
      model: "new-model",
    });
    await h.ingestor.ingest(
      h.source,
      { ...ref, updatedAt: 2000 },
      { workspacePath: "/workspace" }
    );
    expect(h.sessions.updateMetadata).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledExactlyOnceWith("/workspace");
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
  });
  it("compares the complete durable cursor including provider-specific state", async () => {
    const h = harness();
    const batch = { ...(await h.source.readSince()), messages: [] };
    h.source.readSince.mockResolvedValue(batch);
    h.persistence.getCursor.mockResolvedValue({
      ...batch.cursor,
      codexFallbackCalls: ["call-before-wrapper"],
    } as any);
    await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
    expect(h.persistence.appendAndAdvance).toHaveBeenCalledOnce();
  });
  it("keeps pre-row sidecar cursors separate and preserves a held cursor with pending source work", async () => {
    const h = harness();
    h.persistence.resolveSessionId.mockResolvedValue(null as any);
    const batch = {
      ...(await h.source.readSince()),
      messages: [],
      hasMore: true,
      title: "Parent title",
      titleKind: "explicit",
      model: "header-model",
    };
    h.source.readSince
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce({
        ...batch,
        cursor: { ...batch.cursor, byteOffset: 10 },
        title: "Sidecar title",
      })
      .mockResolvedValueOnce({
        ...batch,
        title: undefined,
        titleKind: undefined,
        model: undefined,
      });
    await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
    await h.ingestor.ingest(
      h.source,
      { ...ref, filePath: "/sidecar" },
      { workspacePath: "/workspace" }
    );
    const held = await h.ingestor.ingest(h.source, ref, {
      workspacePath: "/workspace",
    });
    expect(held.hasMore).toBe(true);
    expect(
      h.source.readSince.mock.calls.slice(1).map((args: any[]) => args[1])
    ).toEqual([null, null, batch.cursor]);
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
    h.source.readSince.mockResolvedValue({
      ...batch,
      messages: [
        {
          sourceEntryId: "real",
          content: "{}",
          direction: "input",
          timestamp: "2026-09-14T12:00:00Z",
        },
      ],
      title: undefined,
      titleKind: undefined,
      model: undefined,
    });
    await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Parent title", model: "header-model" })
    );
    expect(h.persistence.appendAndAdvance).toHaveBeenCalledWith(
      expect.objectContaining({ expectedCursor: null })
    );
    expect(h.sessions.updateMetadata).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        metadata: expect.objectContaining({
          externalLastImportedTitleKind: "explicit",
        }),
      })
    );
  });
  it("bounds provisional files, clears them on stop, and discards metadata after source reset", async () => {
    const h = harness(2);
    h.persistence.resolveSessionId.mockResolvedValue(null as any);
    const batch = {
      ...(await h.source.readSince()),
      messages: [],
      hasMore: true,
      title: "Old title",
      model: "old-model",
    };
    h.source.readSince.mockResolvedValue(batch);
    for (const filePath of ["/a", "/b", "/c", "/a"])
      await h.ingestor.ingest(
        h.source,
        { ...ref, filePath },
        { workspacePath: "/workspace" }
      );
    expect(h.source.readSince.mock.calls.at(-1)[1]).toBeNull();
    expect((h.ingestor as any).provisional.size).toBe(2);
    h.source.readSince.mockResolvedValue({
      ...batch,
      reset: true,
      cursor: { ...batch.cursor, inode: 2 },
      title: undefined,
      model: undefined,
    });
    await h.ingestor.ingest(
      h.source,
      { ...ref, filePath: "/a" },
      { workspacePath: "/workspace" }
    );
    h.source.readSince.mockResolvedValue({
      ...batch,
      reset: false,
      cursor: { ...batch.cursor, inode: 2 },
      title: undefined,
      model: undefined,
      messages: [
        {
          sourceEntryId: "new",
          content: "{}",
          direction: "input",
          timestamp: "2026-09-14T12:00:00Z",
        },
      ],
    });
    await h.ingestor.ingest(
      h.source,
      { ...ref, filePath: "/a" },
      { workspacePath: "/workspace" }
    );
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Imported Session" })
    );
    expect(h.sessions.create.mock.calls[0][0].model).not.toBe("old-model");
    await h.ingestor.stop();
    expect((h.ingestor as any).provisional.size).toBe(0);
  });
  it("continues an external batch across unrelated local streaming events without per-token reads", async () => {
    const h = harness();
    h.sessions.get.mockImplementation(async (id) =>
      id === "streaming-local"
        ? { ...h.session, id, providerConfig: {} }
        : h.session
    );
    const batch = await h.source.readSince();
    let release!: (batch: any) => void;
    h.source.readSince.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = h.ingestor.ingest(h.source, ref, {
      workspacePath: "/workspace",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    for (let token = 0; token < 500; token++)
      h.ingestor.fenceLocalOwnership("streaming-local");
    release(batch);
    expect((await pending).messagesAdded).toBe(1);
    expect(
      h.sessions.get.mock.calls.filter(([id]) => id === "streaming-local")
    ).toHaveLength(0);
    expect(h.persistence.appendAndAdvance).toHaveBeenCalledOnce();
  });
  it.each(["get", "updateMetadata"] as const)(
    "recovers a failed %s takeover without fencing unrelated imports or retrying per event",
    async (operation) => {
      const h = harness();
      const local = { ...h.session, id: "resumed", metadata: {} };
      h.sessions.get.mockImplementation(async (id) =>
        id === "resumed" ? local : h.session
      );
      h.sessions.updateMetadata.mockImplementation(async (id, patch) => {
        if (id === "resumed")
          local.metadata = { ...local.metadata, ...patch.metadata };
      });
      h.sessions[operation].mockRejectedValueOnce(
        new Error("database unavailable")
      );
      await expect(h.ingestor.takeLocalOwnership("resumed")).rejects.toThrow(
        "database unavailable"
      );
      expect(
        (
          await h.ingestor.ingest(h.source, ref, {
            workspacePath: "/workspace",
          })
        ).messagesAdded
      ).toBe(1);
      await h.ingestor.takeLocalOwnership("resumed");
      expect(local.metadata).toMatchObject({
        externalIngestionOwner: "nimbalyst",
      });
      const reads = h.sessions.get.mock.calls.length;
      for (let n = 0; n < 100; n++)
        await h.ingestor.takeLocalOwnership("resumed");
      expect(h.sessions.get).toHaveBeenCalledTimes(reads);
      h.persistence.resolveSessionId.mockResolvedValue("resumed");
      expect(
        (
          await h.ingestor.ingest(h.source, ref, {
            workspacePath: "/workspace",
          })
        ).skipped
      ).toBe(true);
    }
  );
  it("rejects saturated local claims before execution and recovers capacity without a global latch", async () => {
    const h = harness(2);
    const release: Array<() => void> = [];
    h.sessions.get
      .mockImplementationOnce(
        () => new Promise((resolve) => release.push(() => resolve(h.session)))
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => release.push(() => resolve(h.session)))
      );
    const first = h.ingestor.takeLocalOwnership("one");
    const second = h.ingestor.takeLocalOwnership("two");
    await expect(h.ingestor.takeLocalOwnership("three")).rejects.toThrow();
    for (const resolve of release) resolve();
    await Promise.all([first, second]);
    await h.ingestor.takeLocalOwnership("three");
    expect(
      (await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" }))
        .messagesAdded
    ).toBe(1);
  });
  it("does not retain failed claims or globally disable following after more than 256 failures", async () => {
    const h = harness();
    h.sessions.get.mockRejectedValue(new Error("offline"));
    for (let index = 0; index < 300; index++)
      await expect(
        h.ingestor.takeLocalOwnership(`failed-${index}`)
      ).rejects.toThrow("offline");
    expect((h.ingestor as any).uncertainOwnership.size).toBe(0);
    expect((h.ingestor as any).ownershipWrites.size).toBe(0);
    h.sessions.get.mockResolvedValue(h.session);
    expect(
      (await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" }))
        .messagesAdded
    ).toBe(1);
  });
  it("fences a starting local alias session whose provider binding is not yet persisted", async () => {
    const sessions = {
      get: vi.fn(async () => ({
        provider: "claude-code-cli",
        workspacePath: "/workspace",
        providerSessionId: undefined,
      })),
    };
    const manager = {
      getTrackedSessionIds: () => ["launching"],
      getSessionState: () => ({
        status: "running",
        workspacePath: "/workspace",
      }),
    };
    expect(
      await hasPendingExternalOwnership(sessions as any, manager as any, ref, {
        workspacePath: "/workspace",
      })
    ).toBe(true);
    manager.getSessionState = () => ({
      status: "idle",
      workspacePath: "/workspace",
    });
    expect(
      await hasPendingExternalOwnership(sessions as any, manager as any, ref, {
        workspacePath: "/workspace",
      })
    ).toBe(false);
  });
  it("persists local takeover and fences a batch whose source read was already pending", async () => {
    const h = harness();
    let release!: (batch: any) => void;
    const batch = await h.source.readSince();
    h.source.readSince.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    const ingestion = h.ingestor.ingest(h.source as any, ref, {
      workspacePath: "/workspace",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
      h.session.metadata = { ...h.session.metadata, ...patch.metadata };
    });
    const claiming = h.ingestor.takeLocalOwnership("local");
    expect(h.sessions.updateMetadata).not.toHaveBeenCalled();
    release(batch);
    await claiming;
    await ingestion;
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
    expect(h.session.metadata).toMatchObject({
      externalIngestionOwner: "nimbalyst",
    });
    // A new ingestor represents restart after SessionStateManager has evicted the turn.
    const restarted = new ExternalSessionIngestor({
      sessions: h.sessions,
      persistence: h.persistence,
      getSessionState: () => null,
      processNewMessages: vi.fn(),
      refresh: vi.fn(),
    } as any);
    await restarted.ingest(h.source as any, ref, {
      workspacePath: "/workspace",
    });
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
  });
  it("records a new placeholder and accepts successive parent titles without adding raw messages", async () => {
    const h = harness();
    h.persistence.resolveSessionId.mockResolvedValueOnce(null as never);
    h.sessions.create.mockImplementation(async (payload) => {
      h.session.title = payload.title!;
    });
    h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
      h.session.metadata = { ...h.session.metadata, ...patch.metadata };
      if (patch.title !== undefined) h.session.title = patch.title;
    });
    await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
    expect(h.session.title).toBe("Imported Session");
    expect(h.session.metadata).toMatchObject({
      externalLastImportedTitle: "Imported Session",
    });
    const batch = { ...(await h.source.readSince()), messages: [] };
    h.persistence.getCursor.mockResolvedValue(batch.cursor as never);
    h.persistence.appendAndAdvance.mockClear();
    h.refresh.mockClear();
    for (const title of ["First external name", "Second external name"]) {
      h.source.readSince.mockResolvedValue({ ...batch, title });
      await h.ingestor.ingest(
        h.source,
        { ...ref, title: "Stale prompt fallback" },
        { workspacePath: "/workspace" }
      );
      expect(h.session.title).toBe(title);
      expect(h.session.metadata).toMatchObject({
        externalLastImportedTitle: title,
      });
    }
    h.source.readSince.mockResolvedValue(batch);
    await h.ingestor.ingest(
      h.source,
      { ...ref, title: "Stale prompt fallback" },
      { workspacePath: "/workspace" }
    );
    expect(h.session.title).toBe("Second external name");
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });
  it.each([
    {
      title: "Imported Session",
      hasBeenNamed: false,
      previous: undefined,
      expected: "External name",
    },
    {
      title: "Imported Session",
      hasBeenNamed: true,
      previous: undefined,
      expected: "Imported Session",
    },
    {
      title: "Imported Session",
      hasBeenNamed: true,
      previous: "Imported Session",
      expected: "Imported Session",
    },
    {
      title: "My chosen title",
      hasBeenNamed: true,
      previous: "My chosen title",
      expected: "My chosen title",
    },
    {
      title: "My chosen title",
      hasBeenNamed: true,
      previous: "Old external name",
      expected: "My chosen title",
    },
    {
      title: "Imported Session",
      hasBeenNamed: false,
      previous: "Old external name",
      expected: "External name",
    },
  ])(
    "repairs only unclaimed legacy placeholder: $title/$hasBeenNamed/$previous",
    async ({ title, hasBeenNamed, previous, expected }) => {
      const h = harness();
      h.session.title = title;
      h.session.hasBeenNamed = hasBeenNamed;
      h.session.metadata = { externalLastImportedTitle: previous };
      h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
        h.session.metadata = { ...h.session.metadata, ...patch.metadata };
        if (patch.title !== undefined) h.session.title = patch.title;
      });
      h.source.readSince.mockResolvedValue({
        ...(await h.source.readSince()),
        messages: [],
        title: "External name",
      });
      await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
      expect(h.session.title).toBe(expected);
    }
  );
  it.each([
    { stored: "explicit", incoming: "fallback", accept: false },
    { stored: "generated", incoming: "fallback", accept: false },
    { stored: "explicit", incoming: "generated", accept: false },
    { stored: undefined, incoming: "fallback", accept: false },
    { stored: undefined, incoming: "generated", accept: true },
    { stored: undefined, incoming: "explicit", accept: true },
    { stored: undefined, incoming: undefined, accept: true },
    { stored: "explicit", incoming: undefined, accept: false },
    { stored: "generated", incoming: "explicit", accept: true },
  ])(
    "preserves title authority $stored -> $incoming",
    async ({ stored, incoming, accept }) => {
      const h = harness();
      h.session.title = "Established name";
      h.session.metadata = {
        externalSource: ref.providerId,
        externalLastActivityAt: ref.updatedAt,
        ...(stored
          ? {
              externalLastImportedTitle: "Established name",
              externalLastImportedTitleKind: stored,
            }
          : {}),
      };
      const batch = {
        ...(await h.source.readSince()),
        messages: [],
        title: "Incoming name",
        titleKind: incoming,
      };
      h.source.readSince.mockResolvedValue(batch);
      h.persistence.getCursor.mockResolvedValue(batch.cursor as never);
      h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
        h.session.metadata = { ...h.session.metadata, ...patch.metadata };
        if (patch.title !== undefined) h.session.title = patch.title;
      });
      await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
      expect(h.session.title).toBe(
        accept ? "Incoming name" : "Established name"
      );
      if (accept)
        expect(h.session.metadata).toMatchObject({
          externalLastImportedTitle: "Incoming name",
          externalLastImportedTitleKind: incoming ?? "generated",
        });
      else expect(h.sessions.updateMetadata).not.toHaveBeenCalled();
      await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
      expect(h.sessions.updateMetadata).toHaveBeenCalledTimes(accept ? 1 : 0);
      expect(h.refresh).toHaveBeenCalledTimes(accept ? 1 : 0);
      expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
      expect(h.processNewMessages).toHaveBeenCalledTimes(2);
    }
  );
  it("upgrades matching title authority once without letting later identical fallback weaken it", async () => {
    const h = harness();
    h.session.title = "Same name";
    h.session.metadata = {
      externalSource: ref.providerId,
      externalLastActivityAt: ref.updatedAt,
      externalLastImportedTitle: "Same name",
      externalLastImportedTitleKind: "generated",
    };
    const batch = {
      ...(await h.source.readSince()),
      messages: [],
      title: "Same name",
      titleKind: "explicit",
    };
    h.source.readSince.mockResolvedValue(batch);
    h.persistence.getCursor.mockResolvedValue(batch.cursor as never);
    h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
      h.session.metadata = { ...h.session.metadata, ...patch.metadata };
    });
    await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
    expect(h.session.metadata).toMatchObject({
      externalLastImportedTitleKind: "explicit",
    });
    h.source.readSince.mockResolvedValue({ ...batch, titleKind: "fallback" });
    await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
    expect(h.sessions.updateMetadata).toHaveBeenCalledExactlyOnceWith("local", {
      metadata: { externalLastImportedTitleKind: "explicit" },
    });
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "repairs a placeholder with fallback unless locally named: %s",
    async (hasBeenNamed) => {
      const h = harness();
      h.session.title = "Imported Session";
      h.session.hasBeenNamed = hasBeenNamed;
      h.session.metadata = {
        externalLastImportedTitle: "Older name",
        externalLastImportedTitleKind: "explicit",
      };
      h.source.readSince.mockResolvedValue({
        ...(await h.source.readSince()),
        messages: [],
        title: "Prompt fallback",
        titleKind: "fallback",
      });
      h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
        h.session.metadata = { ...h.session.metadata, ...patch.metadata };
        if (patch.title !== undefined) h.session.title = patch.title;
      });
      await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
      expect(h.session.title).toBe(
        hasBeenNamed ? "Imported Session" : "Prompt fallback"
      );
      expect(h.session.metadata).toMatchObject({
        externalLastImportedTitleKind: hasBeenNamed ? "explicit" : "fallback",
      });
    }
  );
  it.each(["generated", "explicit"] as const)(
    "protects a literal Imported Session name with recorded %s authority",
    async (kind) => {
      const h = harness();
      h.session.title = "Imported Session";
      h.session.metadata = {
        externalSource: ref.providerId,
        externalLastActivityAt: ref.updatedAt,
        externalLastImportedTitle: "Imported Session",
        externalLastImportedTitleKind: kind,
      };
      const batch = {
        ...(await h.source.readSince()),
        messages: [],
        title: "Prompt fallback",
        titleKind: "fallback",
      };
      h.source.readSince.mockResolvedValue(batch);
      h.persistence.getCursor.mockResolvedValue(batch.cursor as never);
      await h.ingestor.ingest(h.source, ref, { workspacePath: "/workspace" });
      expect(h.sessions.updateMetadata).not.toHaveBeenCalled();
      expect(h.refresh).not.toHaveBeenCalled();
    }
  );
  it.each([false, true])(
    "never lets a sidecar title name its parent (new session: %s)",
    async (newSession) => {
      const h = harness();
      h.session.title = "Parent name";
      h.session.metadata = { externalLastImportedTitle: "Parent name" };
      if (newSession)
        h.persistence.resolveSessionId.mockResolvedValueOnce(null as never);
      h.sessions.create.mockImplementation(async (payload) => {
        h.session.title = payload.title!;
      });
      h.sessions.updateMetadata.mockImplementation(async (_id, patch) => {
        h.session.metadata = { ...h.session.metadata, ...patch.metadata };
        if (patch.title !== undefined) h.session.title = patch.title;
      });
      h.source.readSince.mockResolvedValue({
        ...(await h.source.readSince()),
        title: "Sidecar task title",
      });
      await h.ingestor.ingest(
        h.source,
        { ...ref, parentToolUseId: "agent", title: "Sidecar fallback" },
        { workspacePath: "/workspace" }
      );
      expect(h.session.title).toBe(
        newSession ? "Imported Session" : "Parent name"
      );
    }
  );
  it("updates a CLI title only while it still equals the last imported title", async () => {
    const h = harness();
    h.session.title = "CLI title";
    h.session.metadata = { externalLastImportedTitle: "CLI title" };
    h.source.readSince.mockResolvedValue({
      ...(await h.source.readSince()),
      title: "Later CLI title",
    });
    await h.ingestor.ingest(h.source as any, ref, {
      workspacePath: "/workspace",
    });
    expect(h.sessions.updateMetadata).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({ title: "Later CLI title" })
    );
    h.session.title = "User title";
    h.sessions.updateMetadata.mockClear();
    await h.ingestor.ingest(h.source as any, ref, {
      workspacePath: "/workspace",
    });
    expect(h.sessions.updateMetadata.mock.calls[0][1].title).toBeUndefined();
  });
  it("serializes parent and late sidecar commits, then derives canonical events before refreshing the owning workspace", async () => {
    const h = harness();
    let release!: () => void;
    h.persistence.appendAndAdvance.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r;
        })
    );
    const first = h.ingestor.ingest(h.source as any, ref, {
      workspacePath: "/workspace",
      worktreeId: "tree",
    });
    await vi.waitFor(() =>
      expect(h.persistence.appendAndAdvance).toHaveBeenCalledTimes(1)
    );
    const second = h.ingestor.ingest(
      h.source as any,
      { ...ref, filePath: "/sidecar" },
      { workspacePath: "/workspace", worktreeId: "tree" }
    );
    expect(h.source.readSince).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(
      h.persistence.appendAndAdvance.mock.calls[0][0].ref.workspaceId
    ).toBe("/workspace");
    expect(h.processNewMessages).toHaveBeenCalledWith("local", "claude-code");
    expect(h.refresh).toHaveBeenCalledWith("/workspace");
    expect(
      h.sessions.updateMetadata.mock.calls.some(
        ([id, patch]) => patch.title !== undefined
      )
    ).toBe(false);
    expect(h.ingestor.pendingCount).toBe(0);
  });
  it("rechecks eligibility after an awaited source read and does not commit after disable", async () => {
    const h = harness();
    let allowed = true;
    h.source.readSince.mockImplementationOnce(async () => {
      allowed = false;
      return { messages: [], cursor: { byteOffset: 0 }, hasMore: false };
    });
    await h.ingestor.ingest(
      h.source as any,
      ref,
      { workspacePath: "/workspace" },
      { isEligible: () => allowed }
    );
    expect(h.persistence.appendAndAdvance).not.toHaveBeenCalled();
    expect(h.processNewMessages).not.toHaveBeenCalled();
  });
  it("fences canonical delivery after an in-flight commit settles during disable", async () => {
    const h = harness();
    let eligible = true;
    h.persistence.appendAndAdvance.mockImplementationOnce(async () => {
      eligible = false;
    });
    await h.ingestor.ingest(
      h.source,
      ref,
      { workspacePath: "/workspace" },
      { isEligible: () => eligible }
    );
    expect(h.persistence.appendAndAdvance).toHaveBeenCalledOnce();
    expect(h.processNewMessages).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each(["running", "waiting_for_input", "starting"])(
    "does not ingest a %s turn even when it was previously imported",
    async (status) => {
      const h = harness();
      h.state.mockReturnValue({ status } as any);
      await h.ingestor.ingest(h.source as any, ref, {
        workspacePath: "/workspace",
      });
      expect(h.source.readSince).not.toHaveBeenCalled();
    }
  );
  it("skips idle Nimbalyst-owned rows on replay, but idle imported rows remain eligible", async () => {
    const h = harness();
    h.session.providerConfig = {} as any;
    h.state.mockReturnValue({ status: "idle" } as any);
    await h.ingestor.ingest(h.source as any, ref, {
      workspacePath: "/workspace",
    });
    expect(h.source.readSince).not.toHaveBeenCalled();
  });
});

describe("production source -> persistence -> canonical delivery", () => {
  let dir: string;
  let db: SQLiteDatabase;
  let source: ClaudeCodeSource | CodexSource;
  afterEach(async () => {
    await source?.dispose();
    await db?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });
  it("follows explicit source renames through SQLite and refreshes without duplicate raw messages", async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "external-title-"));
    db = new SQLiteDatabase({
      dbDir: path.join(dir, "db"),
      schemaDir: path.resolve(__dirname, "../../../database/sqlite/schemas"),
      sampleRate: 0,
    });
    await db.initialize();
    fixtureDb.current = db;
    const cwd = "/workspace/project";
    const logs = path.join(dir, "logs");
    const file = path.join(logs, encodeWorkspaceDir(cwd), "external.jsonl");
    source = new ClaudeCodeSource({ rootDir: logs });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "assistant",
        cwd,
        sessionId: "external",
        uuid: "initial",
        timestamp: "2026-09-15T12:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Initial response" }],
        },
      }) + "\n"
    );
    const identified = await source.identify(file, [cwd]);
    expect(identified?.title).toBeUndefined();
    const sessions = createPGLiteSessionStore(db);
    const runtime = new TranscriptMigrationService(
      createRawMessageStoreAdapter()
    );
    TranscriptMigrationRepository.setService(runtime);
    const refresh = vi.fn();
    const ingestor = new ExternalSessionIngestor({
      sessions,
      persistence: new ExternalSessionPersistence(db),
      getSessionState: () => null,
      processNewMessages: (id, provider) =>
        TranscriptMigrationRepository.getService().processNewMessages(
          id,
          provider
        ),
      refresh,
    });
    const initial = await ingestor.ingest(source, identified!, {
      workspacePath: cwd,
    });
    expect((await sessions.get(initial.sessionId!))?.title).toBe(
      "Imported Session"
    );
    refresh.mockClear();
    await fs.appendFile(
      file,
      JSON.stringify({
        type: "ai-title",
        sessionId: "external",
        aiTitle: "First external name",
      }) + "\n"
    );
    expect(
      (await ingestor.ingest(source, identified!, { workspacePath: cwd }))
        .messagesAdded
    ).toBe(0);
    expect((await sessions.get(initial.sessionId!))?.title).toBe(
      "First external name"
    );
    expect((await sessions.get(initial.sessionId!))?.metadata).toMatchObject({
      externalLastImportedTitleKind: "generated",
    });
    await fs.appendFile(
      file,
      JSON.stringify({
        type: "custom-title",
        sessionId: "external",
        customTitle: "Second external name",
      }) + "\n"
    );
    await ingestor.ingest(source, identified!, { workspacePath: cwd });
    expect((await sessions.get(initial.sessionId!))?.title).toBe(
      "Second external name"
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    await ingestor.ingest(source, identified!, { workspacePath: cwd });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect((await sessions.get(initial.sessionId!))?.metadata).toMatchObject({
      externalLastImportedTitleKind: "explicit",
    });
    await ingestor.stop();
    await source.dispose();
    await fs.rename(file, file + ".old");
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd,
        sessionId: "external",
        uuid: "after-rotation",
        timestamp: "2026-09-15T12:01:00Z",
        message: { role: "user", content: "A weaker prompt fallback" },
      }) + "\n"
    );
    source = new ClaudeCodeSource({ rootDir: logs });
    const restartedRef = await source.identify(file, [cwd]);
    expect(restartedRef).toMatchObject({
      title: expect.stringContaining("A weaker prompt fallback"),
      titleKind: "fallback",
    });
    const restarted = new ExternalSessionIngestor({
      sessions: createPGLiteSessionStore(db),
      persistence: new ExternalSessionPersistence(db),
      getSessionState: () => null,
      processNewMessages: (id, provider) =>
        runtime.processNewMessages(id, provider),
      refresh,
    });
    await restarted.ingest(source, restartedRef!, { workspacePath: cwd });
    expect(await sessions.get(initial.sessionId!)).toMatchObject({
      title: "Second external name",
      metadata: {
        externalLastImportedTitle: "Second external name",
        externalLastImportedTitleKind: "explicit",
      },
    });
    refresh.mockClear();
    await restarted.ingest(source, restartedRef!, { workspacePath: cwd });
    expect(refresh).not.toHaveBeenCalled();
    const localRename = { title: "User chosen title", hasBeenNamed: true };
    await sessions.updateMetadata(initial.sessionId!, localRename);
    await fs.appendFile(
      file,
      JSON.stringify({
        type: "custom-title",
        sessionId: "external",
        customTitle: "Third external name",
      }) + "\n"
    );
    await restarted.ingest(source, restartedRef!, { workspacePath: cwd });
    expect((await sessions.get(initial.sessionId!))?.title).toBe(
      "User chosen title"
    );
    expect(
      (await db.query("SELECT id FROM ai_agent_messages")).rows
    ).toHaveLength(2);
    await restarted.stop();
  });
  it("keeps a durable Codex index name when the index disappears across source and ingestor restart", async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "external-codex-title-"));
    db = new SQLiteDatabase({
      dbDir: path.join(dir, "db"),
      schemaDir: path.resolve(__dirname, "../../../database/sqlite/schemas"),
      sampleRate: 0,
    });
    await db.initialize();
    fixtureDb.current = db;
    const cwd = "/workspace/project";
    const logs = path.join(dir, "sessions");
    const file = path.join(logs, "2026/09/15/rollout-external.jsonl");
    const index = path.join(dir, "session_index.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        { type: "session_meta", payload: { id: "external", cwd } },
        {
          type: "response_item",
          timestamp: "2026-09-15T12:00:00Z",
          payload: {
            id: "a",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Prompt fallback" }],
          },
        },
      ]
        .map((row) => JSON.stringify(row) + "\n")
        .join("")
    );
    await fs.writeFile(
      index,
      JSON.stringify({
        id: "external",
        thread_name: "Explicit index name",
        updated_at: "2026-09-15T12:01:00Z",
      }) + "\n"
    );
    const sessions = createPGLiteSessionStore(db);
    const persistence = new ExternalSessionPersistence(db);
    const append = vi.spyOn(persistence, "appendAndAdvance");
    const metadata = vi.spyOn(sessions, "updateMetadata");
    const runtime = new TranscriptMigrationService(
      createRawMessageStoreAdapter()
    );
    const refresh = vi.fn();
    const makeIngestor = () =>
      new ExternalSessionIngestor({
        sessions,
        persistence,
        getSessionState: () => null,
        processNewMessages: (id, provider) =>
          runtime.processNewMessages(id, provider),
        refresh,
      });
    source = new CodexSource({ rootDir: logs });
    const identified = await source.identify(file, [cwd]);
    const ingestor = makeIngestor();
    const initial = await ingestor.ingest(source, identified!, {
      workspacePath: cwd,
    });
    expect(await sessions.get(initial.sessionId!)).toMatchObject({
      title: "Explicit index name",
      metadata: { externalLastImportedTitleKind: "explicit" },
    });
    await ingestor.stop();
    await source.dispose();
    await fs.unlink(index);
    source = new CodexSource({ rootDir: logs });
    const restartedRef = await source.identify(file, [cwd]);
    expect(restartedRef).toMatchObject({ titleKind: "fallback" });
    const restarted = makeIngestor();
    append.mockClear();
    metadata.mockClear();
    refresh.mockClear();
    for (let pass = 0; pass < 2; pass++)
      await restarted.ingest(source, restartedRef!, { workspacePath: cwd });
    expect(await sessions.get(initial.sessionId!)).toMatchObject({
      title: "Explicit index name",
      metadata: { externalLastImportedTitleKind: "explicit" },
    });
    expect(append).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(
      (await db.query("SELECT id FROM ai_agent_messages")).rows
    ).toHaveLength(1);
    await restarted.stop();
  });
  it("advances bounded metadata-only pages before creating a session without losing the first message", async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "external-provisional-"));
    db = new SQLiteDatabase({
      dbDir: path.join(dir, "db"),
      schemaDir: path.resolve(__dirname, "../../../database/sqlite/schemas"),
      sampleRate: 0,
    });
    await db.initialize();
    fixtureDb.current = db;
    const cwd = "/workspace/project";
    const logs = path.join(dir, "logs");
    const file = path.join(logs, encodeWorkspaceDir(cwd), "external.jsonl");
    const header =
      JSON.stringify({
        type: "system",
        cwd,
        sessionId: "external",
        aiTitle: "Header title",
        timestamp: "2026-09-14T12:00:00Z",
        padding: "x".repeat(512),
      }) + "\n";
    source = new ClaudeCodeSource({
      rootDir: logs,
      maxReadBytes: Buffer.byteLength(header),
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      header +
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: "external",
          uuid: "first",
          timestamp: "2026-09-14T12:00:00Z",
          message: { role: "user", content: "First after header" },
        }) +
        "\n"
    );
    const identified = await source.identify(file, [cwd]);
    expect(identified).not.toBeNull();
    const runtime = new TranscriptMigrationService(
      createRawMessageStoreAdapter()
    );
    TranscriptMigrationRepository.setService(runtime);
    const persistence = new ExternalSessionPersistence(db);
    const makeIngestor = () =>
      new ExternalSessionIngestor({
        sessions: createPGLiteSessionStore(db),
        persistence,
        getSessionState: () => null,
        processNewMessages: (id, provider) =>
          TranscriptMigrationRepository.getService().processNewMessages(
            id,
            provider
          ),
        refresh: vi.fn(),
      });
    let ingestor = makeIngestor();
    const first = await ingestor.ingest(source, identified!, {
      workspacePath: cwd,
    });
    expect(first).toMatchObject({ messagesAdded: 0, hasMore: true });
    expect(await persistence.resolveSessionId(identified!)).toBeNull();
    await ingestor.stop();
    ingestor = makeIngestor();
    // Restart has no provisional state and safely rereads the metadata page.
    expect(
      await ingestor.ingest(source, identified!, { workspacePath: cwd })
    ).toMatchObject({ messagesAdded: 0, hasMore: true });
    vi.spyOn(persistence, "appendAndAdvance").mockRejectedValueOnce(
      new Error("write failed")
    );
    await expect(
      ingestor.ingest(source, identified!, { workspacePath: cwd })
    ).rejects.toThrow("write failed");
    expect(
      (await db.query("SELECT id FROM ai_agent_messages")).rows
    ).toHaveLength(0);
    // The row now exists, but the failed raw write advanced no durable cursor.
    await ingestor.ingest(source, identified!, { workspacePath: cwd });
    const next = await ingestor.ingest(source, identified!, {
      workspacePath: cwd,
    });
    expect(next.messagesAdded).toBe(1);
    await ingestor.ingest(source, identified!, { workspacePath: cwd });
    expect(
      (await db.query("SELECT id FROM ai_agent_messages")).rows
    ).toHaveLength(1);
    const session = await createPGLiteSessionStore(db).get(next.sessionId!);
    expect(session?.title).toBe("Header title");
    expect(
      (await runtime.getCanonicalEvents(next.sessionId!, "claude-code"))
        .filter((event) => event.eventType === "user_message")
        .map((event) => event.searchableText)
    ).toEqual(["First after header"]);
    await ingestor.stop();
  });
  it.each(["claude-code", "openai-codex"] as const)(
    "%s appends N+M once through restart/rotation and delivers canonical content",
    async (providerId) => {
      dir = await fs.mkdtemp(path.join(tmpdir(), "external-ingestion-"));
      const open = async () => {
        db = new SQLiteDatabase({
          dbDir: path.join(dir, "db"),
          schemaDir: path.resolve(
            __dirname,
            "../../../database/sqlite/schemas"
          ),
          sampleRate: 0,
        });
        await db.initialize();
        fixtureDb.current = db;
      };
      await open();
      const cwd = "/workspace/project";
      const logs = path.join(dir, "logs");
      source =
        providerId === "claude-code"
          ? new ClaudeCodeSource({ rootDir: logs })
          : new CodexSource({ rootDir: logs, now: () => new Date("2026-09-14T12:00:00Z") });
      const file =
        providerId === "claude-code"
          ? path.join(logs, encodeWorkspaceDir(cwd), "external.jsonl")
          : path.join(logs, "2026/09/14/rollout-external.jsonl");
      await fs.mkdir(path.dirname(file), { recursive: true });
      const row = (id: string, text: string) =>
        providerId === "claude-code"
          ? {
              type: "user",
              sessionId: "external",
              uuid: id,
              cwd,
              timestamp: "2026-09-14T12:00:00Z",
              message: { role: "user", content: text },
            }
          : {
              timestamp: "2026-09-14T12:00:00Z",
              type: "response_item",
              payload: {
                id,
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
              },
            };
      const prefix =
        providerId === "openai-codex"
          ? JSON.stringify({
              type: "session_meta",
              timestamp: "2026-09-14T12:00:00Z",
              payload: { id: "external", cwd, forked_from_id: "parent" },
            }) + "\n" + JSON.stringify({
              type: "session_meta",
              payload: { id: "parent", cwd },
            }) + "\n"
          : "";
      const initial = prefix + JSON.stringify(row("a", "First prompt")) + "\n";
      await fs.writeFile(file, initial);
      const [ref] = await source.discover(cwd);
      expect(ref).toMatchObject({ providerId, externalId: "external", workspacePath: cwd });
      const refresh = vi.fn();
      let runtime: TranscriptMigrationService;
      const makeIngestor = () => {
        runtime = new TranscriptMigrationService(
          createRawMessageStoreAdapter()
        );
        TranscriptMigrationRepository.setService(runtime);
        runtime.setOnEventWritten(() => {});
        return new ExternalSessionIngestor({
          sessions: createPGLiteSessionStore(db),
          persistence: new ExternalSessionPersistence(db),
          getSessionState: () => null,
          readLegacyMessages: (id, provider, after) =>
            readLegacyExternalMessages(db, id, provider, after),
          processNewMessages: (id, provider) =>
            TranscriptMigrationRepository.getService().processNewMessages(
              id,
              provider
            ),
          refresh,
        });
      };
      let ingestor = makeIngestor();
      const first = await ingestor.ingest(source, ref, { workspacePath: cwd });
      await fs.appendFile(
        file,
        JSON.stringify(row("b", "Second prompt")) + "\n"
      );
      await Promise.all([
        ingestor.ingest(source, ref, { workspacePath: cwd }),
        ingestor.ingest(source, ref, { workspacePath: cwd }),
      ]);
      expect(
        (await db.query("SELECT id FROM ai_agent_messages")).rows
      ).toHaveLength(2);
      expect(
        (
          await db.query(
            "SELECT searchable_text FROM ai_agent_messages WHERE message_kind IS NOT NULL"
          )
        ).rows
      ).toHaveLength(2);
      await ingestor.stop();
      await db.close();
      await open();
      ingestor = makeIngestor();
      await fs.rename(file, file + ".old");
      await fs.writeFile(
        file,
        initial +
          JSON.stringify(row("b", "Second prompt")) +
          "\n" +
          JSON.stringify(row("c", "Third prompt")) +
          "\n"
      );
      await ingestor.ingest(source, ref, { workspacePath: cwd });
      expect(
        (await db.query("SELECT id FROM ai_agent_messages")).rows
      ).toHaveLength(3);
      const events = await runtime!.getCanonicalEvents(
        first.sessionId!,
        providerId
      );
      expect(
        events
          .filter((event) => event.eventType === "user_message")
          .map((event) => event.searchableText)
      ).toEqual(["First prompt", "Second prompt", "Third prompt"]);
      expect(refresh).toHaveBeenCalledWith(cwd);
      // Existing manual imports had no providerMessageId. Replay must recognize them.
      await db.query("UPDATE ai_agent_messages SET provider_message_id = NULL");
      await db.query("DELETE FROM external_session_cursors");
      await ingestor.ingest(source, ref, { workspacePath: cwd });
      expect(
        (await db.query("SELECT id FROM ai_agent_messages")).rows
      ).toHaveLength(3);
      if (providerId === "claude-code") {
        const parent = {
          type: "assistant",
          sessionId: "external",
          cwd,
          uuid: "spawn",
          timestamp: "2026-09-14T12:01:00Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "agent-1",
                name: "Agent",
                input: { prompt: "Search", subagent_type: "Explore" },
              },
            ],
          },
        };
        await fs.appendFile(file, JSON.stringify(parent) + "\n");
        await ingestor.ingest(source, ref, { workspacePath: cwd });
        const sidecar = path.join(
          path.dirname(file),
          "external/subagents/agent-agent-1.jsonl"
        );
        await fs.mkdir(path.dirname(sidecar), { recursive: true });
        await fs.writeFile(
          sidecar,
          JSON.stringify({
            ...parent,
            uuid: "child",
            isSidechain: true,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Late child answer" },
                {
                  type: "tool_use",
                  id: "child-tool",
                  name: "Glob",
                  input: { pattern: "*.ts" },
                },
              ],
            },
          }) + "\n"
        );
        const refs = await source.discover(cwd);
        const child = refs.find(
          (candidate) => candidate.parentToolUseId === "agent-1"
        )!;
        await ingestor.ingest(source, child, { workspacePath: cwd });
        const incremental = await runtime!.getCanonicalEvents(
          first.sessionId!,
          providerId
        );
        const late = incremental.find(
          (event) => event.providerToolCallId === "child-tool"
        );
        expect(late?.subagentId).toBe("agent-1");
        const rebuilt = new TranscriptMigrationService(
          createRawMessageStoreAdapter()
        );
        const all = await rebuilt.getCanonicalEvents(
          first.sessionId!,
          providerId
        );
        const contentSet = (events: typeof all) =>
          events
            .map((event) => [
              event.eventType,
              event.searchableText,
              event.subagentId,
            ])
            .sort();
        expect(contentSet(incremental)).toEqual(contentSet(all));
      }
      await ingestor.stop();
    }
  );
});
