import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCollabV3Sync,
  mergeContextMeterClientMetadataForTest,
  roundTripClientMetadataForTest,
  shouldCreateFullSyncClientMetadataForTest,
} from "../CollabV3Sync";

const state = {
  schemaVersion: 1 as const,
  confidence: "exact" as const,
  fillTokens: 42_000,
  effectiveWindowTokens: 200_000,
  provenance: {
    identity: {
      nimbalystSessionId: "session-1",
      providerId: "openai-codex",
      persistedModelId: "openai-codex:gpt-5.4",
      upstreamThreadId: "thread-1",
      producerRole: "lead" as const,
    },
    order: {
      processInstanceId: "process-1",
      lifecycleGeneration: 2,
      sequence: 7,
      observedAtMs: 1_000,
    },
    adapterId: "codex-app-server-thread-usage-v1" as const,
    windowPolicy: "runtime-required" as const,
    numeratorSource: "runtime-observation" as const,
    denominatorSource: "runtime-observation" as const,
    runtimeWindowTokens: 200_000,
    acceptedAtMs: 1_000,
    lastFreshObservationAtMs: 1_000,
  },
};

async function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function indexUpdates(socket: FakeWebSocket): Array<Record<string, any>> {
  return socket.send.mock.calls
    .map(([payload]) => JSON.parse(payload as string))
    .filter((message) => message.type === "indexUpdate");
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function encryptClientMetadataForTest(
  metadata: Record<string, unknown>,
  encryptionKey: CryptoKey
): Promise<{ encryptedClientMetadata: string; clientMetadataIv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    new TextEncoder().encode(JSON.stringify(metadata))
  );
  return {
    encryptedClientMetadata: bytesToBase64(new Uint8Array(encrypted)),
    clientMetadataIv: bytesToBase64(iv),
  };
}

async function decryptIndexClientMetadata(
  message: Record<string, any>,
  encryptionKey: CryptoKey
): Promise<Record<string, unknown>> {
  const session = message.session;
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(session.clientMetadataIv) },
    encryptionKey,
    base64ToBytes(session.encryptedClientMetadata)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

describe("CollabV3 encrypted context-meter metadata", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the complete versioned state without cumulative reconstruction", async () => {
    const result = await roundTripClientMetadataForTest(
      {
        tokenUsage: {
          inputTokens: 900_000,
          outputTokens: 100_000,
          totalTokens: 1_000_000,
          contextWindow: 2_000_000,
          contextMeterState: state,
        },
      },
      await key()
    );

    expect(result?.contextMeterState).toEqual(state);
    expect(result?.currentContext).toEqual({
      tokens: 42_000,
      contextWindow: 200_000,
    });
    expect(result?.currentContext?.tokens).not.toBe(1_000_000);
  });

  it("does not create current context from legacy cumulative totals", async () => {
    const result = await roundTripClientMetadataForTest(
      {
        tokenUsage: {
          inputTokens: 90_000,
          outputTokens: 10_000,
          totalTokens: 100_000,
          contextWindow: 200_000,
        },
      },
      await key()
    );

    expect(result).toBeUndefined();
  });

  it("replaces the incremental legacy mirror and clears it for unavailable truth", () => {
    const unavailable = {
      schemaVersion: 1 as const,
      confidence: "unavailable" as const,
      reason: "thread-reset" as const,
      provenance: state.provenance,
    };
    expect(
      mergeContextMeterClientMetadataForTest(
        {
          currentContext: { tokens: 42_000, contextWindow: 200_000 },
          contextMeterState: state,
        },
        { contextMeterState: unavailable }
      )
    ).toEqual({
      currentContext: undefined,
      contextMeterState: unavailable,
    });
  });

  it("creates full-sync client metadata when only pending versioned truth exists", () => {
    expect(
      shouldCreateFullSyncClientMetadataForTest(
        undefined,
        { contextMeterState: state },
        undefined
      )
    ).toBe(true);
  });

  it("full sync does not resurrect raw numeric truth under a pending unavailable state", async () => {
    const encryptionKey = await key();
    const provider = createCollabV3Sync({
      serverUrl: "wss://sync.example.test",
      orgId: "org-1",
      userId: "user-1",
      getJwt: async () => jwtFor("user-1"),
      encryptionKey,
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

    const unavailable = {
      schemaVersion: 1 as const,
      confidence: "unavailable" as const,
      reason: "thread-reset" as const,
      provenance: state.provenance,
    };
    provider.pushChange("session-full-sync", {
      type: "metadata_updated",
      metadata: { contextMeterState: unavailable },
    });
    provider.syncSessionsToIndex?.([
      {
        id: "session-full-sync",
        title: "Context sync",
        provider: "openai-codex",
        workspaceId: "/workspace",
        messageCount: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        metadata: {
          tokenUsage: {
            contextMeterState: state,
          },
        },
      },
    ]);

    await vi.waitFor(() =>
      expect(indexUpdates(indexSocket).length).toBeGreaterThan(0)
    );
    const metadata = await decryptIndexClientMetadata(
      indexUpdates(indexSocket)[0],
      encryptionKey
    );
    expect(metadata.contextMeterState).toEqual(unavailable);
    expect(metadata).not.toHaveProperty("currentContext");
    provider.disconnectAll();
  });

  it("applies a queued unavailable state over cached available truth without retaining its mirror", async () => {
    const encryptionKey = await key();
    const provider = createCollabV3Sync({
      serverUrl: "wss://sync.example.test",
      orgId: "org-1",
      userId: "user-1",
      getJwt: async () => jwtFor("user-1"),
      encryptionKey,
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

    const unavailable = {
      schemaVersion: 1 as const,
      confidence: "unavailable" as const,
      reason: "thread-reset" as const,
      provenance: state.provenance,
    };
    provider.pushChange("session-pending", {
      type: "metadata_updated",
      metadata: { contextMeterState: unavailable },
    });
    const encrypted = await encryptClientMetadataForTest(
      {
        contextMeterState: state,
        currentContext: { tokens: 42_000, contextWindow: 200_000 },
      },
      encryptionKey
    );
    indexSocket.receive({
      type: "indexBroadcast",
      session: {
        sessionId: "session-pending",
        provider: "openai-codex",
        messageCount: 0,
        lastMessageAt: 1_000,
        createdAt: 1_000,
        updatedAt: 1_000,
        ...encrypted,
      },
    });

    await vi.waitFor(() => expect(indexUpdates(indexSocket)).toHaveLength(1));
    const metadata = await decryptIndexClientMetadata(
      indexUpdates(indexSocket)[0],
      encryptionKey
    );
    expect(metadata.contextMeterState).toEqual(unavailable);
    expect(metadata).not.toHaveProperty("currentContext");
    expect(provider.getCachedIndexEntry?.("session-pending")).toMatchObject({
      contextMeterState: unavailable,
      currentContext: undefined,
    });
    provider.disconnectAll();
  });
});
