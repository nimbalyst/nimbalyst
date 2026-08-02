import { afterEach, describe, expect, it, vi } from "vitest";

const settingsKeyMock = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("../../../utils/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/store")>()),
  getProviderApiKeyFromSettings: settingsKeyMock,
}));
vi.mock(
  "../../../../../runtime/src/ai/server/providers/claudeCode/cliPathResolver",
  () => ({ resolveClaudeAgentCliPath: async () => "/fake/claude" })
);
vi.mock("../../../claudeCodeEnvironment", () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider } from "@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider";
import { buildSdkOptions } from "@nimbalyst/runtime/ai/server/providers/claudeCode/sdkOptionsBuilder";
import { ClaudeCodeDeps } from "@nimbalyst/runtime/ai/server/providers/claudeCode/dependencyInjection";
import {
  CLAUDEX_INGRESS_CREDENTIAL_REF,
  OPENROUTER_API_CREDENTIAL_REF,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogDefaults";
import { preflightProviderRuntimeCredentials } from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerRouteCredentials";
import {
  createProviderRuntimeSessionSnapshot,
  type ClaudeAgentRuntimeRouteBundle,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/runtimeRouteResolver";
import { createProviderRouteCredentialResolver } from "../providerRouteCredentialResolver";

const CLAUDEX_TOKEN = "c".repeat(48);
const OPENROUTER_TOKEN = "o".repeat(48);

function makeDeps(
  provider: ClaudeCodeProvider,
  routes: Readonly<ClaudeAgentRuntimeRouteBundle>
): Parameters<typeof buildSdkOptions>[0] {
  const credentials = preflightProviderRuntimeCredentials(
    routes,
    (provider as unknown as { config: Record<string, unknown> }).config
  );
  return {
    resolveModelVariant: () => routes.main.selectedInterface.modelAlias,
    getMcpServersSnapshot: async () => ({}),
    createCanUseToolHandler: () => () => true,
    toolHooksService: {
      createPreToolUseHook: () => () => ({}),
      createPostToolUseHook: () => () => ({}),
      createPermissionDeniedHook: () => () => ({}),
    },
    teammateManager: {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined,
    },
    sessions: { getSessionId: () => null },
    config: (provider as unknown as { config: Record<string, unknown> }).config,
    abortController: new AbortController(),
    mainRouteSnapshot: createProviderRuntimeSessionSnapshot(routes.main),
    subagentRouteSnapshot: createProviderRuntimeSessionSnapshot(
      routes.subagent
    ),
    mainRouteCredential: credentials.main,
    subagentRouteCredential: credentials.subagent,
  } as Parameters<typeof buildSdkOptions>[0];
}

afterEach(() => {
  ClaudeCodeDeps.setProviderCredentialResolver(null);
  settingsKeyMock.mockReset();
});

describe("Electron provider route credential host seam", () => {
  it("resolves only reviewed Claudex and OpenRouter named sources", () => {
    const readTextFile = vi.fn(() => `${CLAUDEX_TOKEN}\n`);
    const getProviderApiKey = vi.fn((providerId: string) =>
      providerId === "openrouter" ? OPENROUTER_TOKEN : null
    );
    const resolver = createProviderRouteCredentialResolver({
      readTextFile,
      getProviderApiKey,
      getClaudexRoot: () => "D:/Users/Test/Claudex",
    });

    expect(resolver(CLAUDEX_INGRESS_CREDENTIAL_REF)).toBe(CLAUDEX_TOKEN);
    expect(readTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/Claudex[\\/]secrets[\\/]ingress\.token$/)
    );
    expect(resolver(OPENROUTER_API_CREDENTIAL_REF)).toBe(OPENROUTER_TOKEN);
    expect(getProviderApiKey).toHaveBeenCalledWith("openrouter", undefined);
    expect(resolver("workspace.not-reviewed")).toBeUndefined();
  });

  it("resolves an OpenRouter key configured only for the active workspace", () => {
    settingsKeyMock.mockImplementation(
      (providerId: string, workspacePath?: string) =>
        providerId === "openrouter" && workspacePath === "D:/workspace-only"
          ? OPENROUTER_TOKEN
          : null
    );
    const resolver = createProviderRouteCredentialResolver({
      readTextFile: () => undefined,
      getClaudexRoot: () => "D:/Users/Test/Claudex",
    });

    expect(
      resolver(OPENROUTER_API_CREDENTIAL_REF, {
        workspacePath: "D:/workspace-only",
      })
    ).toBe(OPENROUTER_TOKEN);
    expect(resolver(OPENROUTER_API_CREDENTIAL_REF)).toBeUndefined();
    expect(settingsKeyMock).toHaveBeenCalledWith(
      "openrouter",
      "D:/workspace-only"
    );
  });

  it.each([
    {
      model: "claude-code:claudex-sol",
      provider: "openai",
      alias: "gpt-5.6-sol",
      endpoint: "http://127.0.0.1:38117",
      token: CLAUDEX_TOKEN,
    },
    {
      model: "claude-code:openrouter-deepseek-v4-flash",
      provider: "openrouter",
      alias: "deepseek/deepseek-v4-flash",
      endpoint: "https://openrouter.ai/api",
      token: OPENROUTER_TOKEN,
    },
  ])(
    "initializes and builds the exact $provider route through the installed host resolver",
    async ({ model, provider: providerId, alias, endpoint, token }) => {
      const resolver = createProviderRouteCredentialResolver({
        readTextFile: () => CLAUDEX_TOKEN,
        getProviderApiKey: () => OPENROUTER_TOKEN,
        getClaudexRoot: () => "D:/Users/Test/Claudex",
      });
      ClaudeCodeProvider.setProviderCredentialResolver(resolver);
      const provider = new ClaudeCodeProvider();
      await provider.initialize({ model });
      const routes = (
        provider as unknown as {
          runtimeRoutes: Readonly<ClaudeAgentRuntimeRouteBundle>;
        }
      ).runtimeRoutes;

      const result = await buildSdkOptions(makeDeps(provider, routes), {
        message: "host-seam-test",
        workspacePath: "D:/workspace",
        sessionId: "session-host-seam",
        settingsEnv: {},
        shellEnv: {},
        systemPrompt: "",
        currentMode: undefined,
        imageContentBlocks: [],
        documentContentBlocks: [],
      });

      expect(routes.main.provider).toBe(providerId);
      expect(result.options.model).toBe(alias);
      expect(result.options.env.ANTHROPIC_BASE_URL).toBe(endpoint);
      expect(result.options.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
      expect(result.options.env.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    }
  );
});
