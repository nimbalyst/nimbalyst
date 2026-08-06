import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { AISessionsRepository } from "../../../../storage/repositories/AISessionsRepository";
import { ClaudeCodeProvider } from "../ClaudeCodeProvider";
import { ClaudeCodeDeps } from "../claudeCode/dependencyInjection";
import {
  BUILT_IN_PROVIDER_CATALOG,
  CLAUDEX_SOL_ENTRY_ID,
} from "../claudeCode/providerCatalogDefaults";
import {
  PROVIDER_CATALOG_OVERLAY_FILE,
  readProviderCatalogFromDirectory,
} from "../claudeCode/providerCatalogLoader";
import { persistProviderRuntimeRouteSnapshot } from "../claudeCode/providerRuntimeRoutePersistence";
import {
  ProviderRuntimeRouteError,
  type ClaudeAgentRuntimeRouteBundle,
} from "../claudeCode/runtimeRouteResolver";

const TEST_CREDENTIAL = "test-only-credential-value-with-forty-characters";
const tempDirectories: string[] = [];

function runtimeRoutes(provider: ClaudeCodeProvider) {
  return (
    provider as unknown as {
      runtimeRoutes: Readonly<ClaudeAgentRuntimeRouteBundle>;
    }
  ).runtimeRoutes;
}

function contextObservation(
  provider: ClaudeCodeProvider,
  sessionId: string,
  fillTokens: number,
  runtimeWindowTokens?: number
) {
  const internals = provider as unknown as {
    sessions: {
      captureSessionId: (sessionId: string, upstreamId: string) => void;
    };
    createLeadContextObservation: (
      sessionId: string,
      fillTokens: number,
      runtimeWindowTokens?: number
    ) => unknown;
  };
  internals.sessions.captureSessionId(sessionId, "claude-thread-1");
  return internals.createLeadContextObservation(
    sessionId,
    fillTokens,
    runtimeWindowTokens
  );
}

function reverseJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseJsonObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseJsonObjectKeys(item)])
  );
}

afterEach(() => {
  ClaudeCodeDeps.setProviderCredentialResolver(null);
  ClaudeCodeDeps.setProviderCatalogResolutionLoader(null);
  vi.restoreAllMocks();
  queryMock.mockReset();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ClaudeCodeProvider runtime route preflight", () => {
  it("code-binds native Claude telemetry without a custom catalog route", async () => {
    const provider = new ClaudeCodeProvider();
    await provider.initialize({ model: "claude-code:haiku" });

    expect(runtimeRoutes(provider)).toBeUndefined();
    expect(
      contextObservation(provider, "native-session", 42_000, 200_000)
    ).toMatchObject({
      schemaVersion: 1,
      fillTokens: 42_000,
      runtimeWindowTokens: 200_000,
      adapterId: "claude-agent-sdk-parent-v1",
      windowPolicy: "runtime-then-model-seed",
      contextWindowSeedTokens: 200_000,
      identity: {
        nimbalystSessionId: "native-session",
        providerId: "claude-code",
        persistedModelId: "claude-code:haiku",
        providerModelId: "haiku",
        interfaceId: "claude-agent-sdk-native",
        upstreamThreadId: "claude-thread-1",
        producerRole: "lead",
      },
    });
  });

  it("freezes lead context telemetry to the selected catalog route", async () => {
    ClaudeCodeDeps.setProviderCredentialResolver(() => TEST_CREDENTIAL);
    const provider = new ClaudeCodeProvider();
    await provider.initialize({ model: "claude-code:claudex-sol" });

    expect(
      contextObservation(provider, "session-context", 42_000)
    ).toMatchObject({
      schemaVersion: 1,
      fillTokens: 42_000,
      adapterId: "claude-agent-sdk-parent-v1",
      windowPolicy: "runtime-then-model-seed",
      contextWindowSeedTokens: 372_000,
      numeratorSemantics: "current-lead-context",
      identity: {
        nimbalystSessionId: "session-context",
        persistedModelId: "claude-code:claudex-sol",
        catalogEntryId: CLAUDEX_SOL_ENTRY_ID,
        interfaceId: runtimeRoutes(provider).main.selectedInterface.id,
        upstreamThreadId: "claude-thread-1",
        producerRole: "lead",
      },
      order: { lifecycleGeneration: 0, sequence: 1 },
    });

    expect(
      contextObservation(provider, "session-context", 43_000, 400_000)
    ).toMatchObject({
      runtimeWindowTokens: 400_000,
      order: { lifecycleGeneration: 0, sequence: 2 },
    });

    (
      provider as unknown as {
        advanceContextMeterGeneration: (sessionId: string) => void;
      }
    ).advanceContextMeterGeneration("session-context");
    expect(
      contextObservation(provider, "session-context", 9_000, 400_000)
    ).toMatchObject({
      fillTokens: 9_000,
      order: { lifecycleGeneration: 1, sequence: 2 },
    });
  });

  it("rejects a revoked credential before attachment, controller, hook, persistence, queue, or process mutation", async () => {
    ClaudeCodeDeps.setProviderCredentialResolver(() => TEST_CREDENTIAL);
    const provider = new ClaudeCodeProvider();
    await provider.initialize({ model: "claude-code:claudex-sol" });
    ClaudeCodeDeps.setProviderCredentialResolver(() => undefined);

    const providerInternals = provider as unknown as Record<string, unknown>;
    providerInternals.markMessagesAsHidden = true;
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");
    providerInternals.abortController = abortController;
    const hookSpy = vi.spyOn(
      provider as unknown as { createToolHooksService: () => unknown },
      "createToolHooksService"
    );
    const readSpy = vi.spyOn(fs.promises, "readFile");
    const writeSpy = vi.spyOn(fs.promises, "writeFile");
    const repositoryGet = vi.spyOn(AISessionsRepository, "get");
    const repositoryUpdate = vi.spyOn(AISessionsRepository, "updateMetadata");
    const repositoryInstall = vi.spyOn(
      AISessionsRepository,
      "installMetadataValueIfAbsent"
    );

    const next = provider
      .sendMessage("hello", undefined, "session-revoked", [], "D:/workspace", [
        {
          type: "document",
          filepath: "D:/would-not-be-read.txt",
          filename: "would-not-be-read.txt",
        },
      ])
      .next();

    await expect(next).rejects.toMatchObject({
      name: "ProviderRuntimeRouteError",
      code: "credential-unavailable",
      stage: "pre-mutation",
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(hookSpy).not.toHaveBeenCalled();
    expect(repositoryGet).not.toHaveBeenCalled();
    expect(repositoryUpdate).not.toHaveBeenCalled();
    expect(repositoryInstall).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(providerInternals.abortController).toBe(abortController);
    expect(providerInternals.markMessagesAsHidden).toBe(true);
  });

  it("hydrates a durable snapshot after provider reconstruction and rejects overlay drift on resume", async () => {
    ClaudeCodeDeps.setProviderCredentialResolver(() => TEST_CREDENTIAL);
    const directory = fs.mkdtempSync(
      path.join(process.cwd(), ".packet2-provider-catalog-")
    );
    tempDirectories.push(directory);
    const readCurrentCatalog = () =>
      readProviderCatalogFromDirectory(directory, BUILT_IN_PROVIDER_CATALOG)
        .resolution;
    const baseResolution = readCurrentCatalog();
    ClaudeCodeDeps.setProviderCatalogResolutionLoader(readCurrentCatalog);
    const firstProvider = new ClaudeCodeProvider();
    await firstProvider.initialize({ model: "claude-code:claudex-sol" });

    let persistedWinner: unknown;
    const repositoryInstall = vi
      .spyOn(AISessionsRepository, "installMetadataValueIfAbsent")
      .mockImplementation(async (_sessionId, _key, value) => {
        if (persistedWinner === undefined) persistedWinner = value;
        return persistedWinner;
      });
    await persistProviderRuntimeRouteSnapshot(
      "session-reconstructed",
      runtimeRoutes(firstProvider)
    );
    persistedWinner = reverseJsonObjectKeys(persistedWinner);
    const persistedWinnerJson = JSON.stringify(persistedWinner);

    const unchangedReconstructedProvider = new ClaudeCodeProvider();
    await unchangedReconstructedProvider.initialize({
      model: "claude-code:claudex-sol",
    });
    await expect(
      persistProviderRuntimeRouteSnapshot(
        "session-reconstructed",
        runtimeRoutes(unchangedReconstructedProvider)
      )
    ).resolves.toMatchObject({ schemaVersion: 1 });

    const baseEntry = baseResolution.entries.find(
      (entry) => entry.id === CLAUDEX_SOL_ENTRY_ID
    );
    if (!baseEntry) throw new Error("missing Claudex Sol test entry");
    fs.writeFileSync(
      path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE),
      `${JSON.stringify({
        schemaVersion: 2,
        entries: [
          {
            id: CLAUDEX_SOL_ENTRY_ID,
            patch: {
              interfaces: baseEntry.interfaces.map((catalogInterface) => ({
                ...catalogInterface,
                endpoint: "http://127.0.0.1:38117/v1",
              })),
            },
          },
        ],
      })}\n`,
      "utf8"
    );

    const reconstructedProvider = new ClaudeCodeProvider();
    await reconstructedProvider.initialize({
      model: "claude-code:claudex-sol",
    });
    const repositoryGet = vi.spyOn(AISessionsRepository, "get");
    const updateSpy = vi.spyOn(AISessionsRepository, "updateMetadata");
    const attachmentRead = vi.spyOn(fs.promises, "readFile");
    const attachmentWrite = vi.spyOn(fs.promises, "writeFile");

    const resumeError = await reconstructedProvider
      .sendMessage(
        "resume",
        undefined,
        "session-reconstructed",
        [],
        "D:/workspace",
        [
          {
            type: "document",
            filepath: "D:/would-not-be-read.txt",
            filename: "would-not-be-read.txt",
          },
        ]
      )
      .next()
      .catch((error) => error as unknown);
    expect(resumeError).toBeInstanceOf(ProviderRuntimeRouteError);
    expect(resumeError).toMatchObject({
      code: "immutable-session-route",
      message: expect.stringContaining(
        "already owns a different or invalid durable provider route"
      ),
    });
    expect(repositoryInstall).toHaveBeenCalledTimes(3);
    const changedCandidate =
      repositoryInstall.mock.calls[
        repositoryInstall.mock.calls.length - 1
      ]?.[2];
    expect(changedCandidate).not.toEqual(persistedWinner);
    expect(JSON.stringify(persistedWinner)).toBe(persistedWinnerJson);
    expect(repositoryGet).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(attachmentRead).not.toHaveBeenCalled();
    expect(attachmentWrite).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
