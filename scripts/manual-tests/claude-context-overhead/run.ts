import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { buildClaudeCodeSystemPrompt } from "../../../packages/runtime/src/ai/prompt";

type ProfileName =
  | "raw"
  | "addendum"
  | "core"
  | "platform-mcp"
  | "extension-mcp"
  | "all-mcp"
  | "plugins"
  | "full";

interface Profile {
  addendum: boolean;
  coreMcp: boolean;
  platformMcp: boolean;
  extensionMcp: boolean;
  plugins: boolean;
}

interface EndpointDescriptor {
  port: number;
  token: string;
}

interface McpServerConfig {
  type: "sse";
  url: string;
  headers: { Authorization: string };
}

const requestedProfile = process.argv[2];
const profileName = (
  requestedProfile === "nimbalyst" ? "full" : requestedProfile
) as ProfileName | undefined;
const dryRun = process.argv.includes("--dry-run");

const profiles: Record<ProfileName, Profile> = {
  raw: {
    addendum: false,
    coreMcp: false,
    platformMcp: false,
    extensionMcp: false,
    plugins: false,
  },
  addendum: {
    addendum: true,
    coreMcp: false,
    platformMcp: false,
    extensionMcp: false,
    plugins: false,
  },
  core: {
    addendum: false,
    coreMcp: true,
    platformMcp: false,
    extensionMcp: false,
    plugins: false,
  },
  "platform-mcp": {
    addendum: false,
    coreMcp: false,
    platformMcp: true,
    extensionMcp: false,
    plugins: false,
  },
  "extension-mcp": {
    addendum: false,
    coreMcp: false,
    platformMcp: false,
    extensionMcp: true,
    plugins: false,
  },
  "all-mcp": {
    addendum: false,
    coreMcp: true,
    platformMcp: true,
    extensionMcp: true,
    plugins: false,
  },
  plugins: {
    addendum: false,
    coreMcp: false,
    platformMcp: false,
    extensionMcp: false,
    plugins: true,
  },
  full: {
    addendum: true,
    coreMcp: true,
    platformMcp: true,
    extensionMcp: true,
    plugins: true,
  },
};

if (!profileName || !profiles[profileName]) {
  console.error(
    "Usage: npx tsx scripts/manual-tests/claude-context-overhead/run.ts <raw|addendum|core|platform-mcp|extension-mcp|all-mcp|plugins|full> [--dry-run]"
  );
  process.exit(2);
}

const profile = profiles[profileName];

const workspacePath = process.cwd();
const homePath = homedir();
const userDataPath =
  process.env.NIMBALYST_USER_DATA_DIR ??
  (process.platform === "darwin"
    ? join(homePath, "Library/Application Support/@nimbalyst/electron")
    : process.platform === "win32"
    ? join(process.env.APPDATA ?? homePath, "@nimbalyst/electron")
    : join(homePath, ".config/@nimbalyst/electron"));
const descriptorPath =
  process.env.NIMBALYST_MCP_DESCRIPTOR ??
  join(userDataPath, "mcp-endpoint.json");
const cliPath =
  process.env.CLAUDE_BIN ?? join(homePath, ".claude/local/claude");
const proxyUrl =
  process.env.CLAUDE_CONTEXT_PROXY_URL ?? "http://127.0.0.1:8377";
const model = process.env.CLAUDE_CONTEXT_MODEL ?? "fable";
const maxBudgetUsd = process.env.CLAUDE_CONTEXT_MAX_BUDGET_USD ?? "2";
const prompt = process.env.CLAUDE_CONTEXT_PROMPT ?? "Reply with only OK.";
const toolSearch = process.env.CLAUDE_CONTEXT_TOOL_SEARCH !== "false";
const configuredMcpSessionId = process.env.NIMBALYST_CONTEXT_SESSION_ID;
const hasSessionNaming =
  process.env.NIMBALYST_CONTEXT_HAS_SESSION_NAMING !== "false";
const hasOutOfBandNaming =
  process.env.NIMBALYST_CONTEXT_OUT_OF_BAND_NAMING !== "false";
const trackersEnabled =
  process.env.NIMBALYST_CONTEXT_TRACKERS_ENABLED !== "false";
const worktreePath = process.env.NIMBALYST_CONTEXT_WORKTREE_PATH;
const isVoiceMode = process.env.NIMBALYST_CONTEXT_VOICE_MODE === "true";
const runLabel = (process.env.CLAUDE_CONTEXT_RUN_LABEL ?? "run").replace(
  /[^a-zA-Z0-9._-]/g,
  "-"
);

if (!existsSync(cliPath)) {
  throw new Error(
    `Claude CLI not found at ${cliPath}. Set CLAUDE_BIN to the current binary.`
  );
}

const defaultExtensionMcpNames = [
  "developer",
  "ios-dev",
  "sqlite-browser",
  "memory",
  "browser",
  "homekit-mcp",
  "namenym",
  "image-generation",
  "jupyter",
  "slides",
  "replicad",
  "mindmap",
  "excalidraw",
  "datamodellm",
  "electronics",
  "automations",
];

const extensionMcpNames = process.env.NIMBALYST_EXTENSION_MCP_NAMES
  ? process.env.NIMBALYST_EXTENSION_MCP_NAMES.split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  : defaultExtensionMcpNames;

const defaultPluginDirs = [
  "automations",
  "datamodellm",
  "developer",
  "excalidraw",
  "ios-dev",
  "mockuplm",
  "nimbalyst-mindmap",
  "nimbalyst-slides",
]
  .map((name) => join(userDataPath, "extensions", name, "claude-plugin"))
  .concat([
    join(workspacePath, "packages/extensions/extension-dev-kit/claude-plugin"),
    join(workspacePath, "packages/extensions/feedback/claude-plugin"),
    join(workspacePath, "packages/extensions/planning/claude-plugin"),
    join(workspacePath, ".claude/plugins/.nimbalyst-generated/electronics"),
  ]);

const pluginDirs = (
  process.env.NIMBALYST_PLUGIN_DIRS
    ? process.env.NIMBALYST_PLUGIN_DIRS.split(delimiter)
    : defaultPluginDirs
).filter((pluginDir) => pluginDir && existsSync(pluginDir));

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 20);
}

function resolveExtensionDevPort(): number | undefined {
  const explicitPort = Number(process.env.NIMBALYST_EXTENSION_DEV_PORT);
  if (Number.isInteger(explicitPort) && explicitPort > 0) {
    return explicitPort;
  }

  const mainLogPath = join(userDataPath, "logs/main.log");
  if (!existsSync(mainLogPath)) {
    return undefined;
  }

  const matches = [
    ...readFileSync(mainLogPath, "utf8").matchAll(
      /\[Extension Dev MCP\] Successfully started on port (\d+)/g
    ),
  ];
  const latestPort = Number(matches.at(-1)?.[1]);
  return Number.isInteger(latestPort) && latestPort > 0
    ? latestPort
    : undefined;
}

const addendum = profile.addendum
  ? buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      hasOutOfBandNaming,
      trackersEnabled,
      worktreePath,
      isVoiceMode,
      toolReferenceStyle: "claude",
    })
  : "";

let mcpServers: Record<string, McpServerConfig> = {};
let extensionDevPort: number | undefined;

if (profile.coreMcp || profile.platformMcp || profile.extensionMcp) {
  if (!existsSync(descriptorPath)) {
    throw new Error(
      `Nimbalyst MCP descriptor not found at ${descriptorPath}. Start Nimbalyst first.`
    );
  }

  const descriptor = JSON.parse(
    readFileSync(descriptorPath, "utf8")
  ) as EndpointDescriptor;
  const sessionId = configuredMcpSessionId ?? crypto.randomUUID();
  const query = `workspacePath=${encodeURIComponent(
    workspacePath
  )}&sessionId=${encodeURIComponent(sessionId)}`;
  const headers = { Authorization: `Bearer ${descriptor.token}` };
  const makeConfig = (port: number, endpoint: string): McpServerConfig => ({
    type: "sse",
    url: `http://127.0.0.1:${port}${endpoint}?${query}`,
    headers,
  });

  if (profile.coreMcp) {
    mcpServers.nimbalyst = makeConfig(descriptor.port, "/mcp/core");
  }
  if (profile.platformMcp) {
    mcpServers["nimbalyst-host"] = makeConfig(descriptor.port, "/mcp/host");
    mcpServers["nimbalyst-trackers"] = makeConfig(
      descriptor.port,
      "/mcp/trackers"
    );
    mcpServers["nimbalyst-situational"] = makeConfig(
      descriptor.port,
      "/mcp/situational"
    );
  }
  if (profile.extensionMcp) {
    for (const shortName of extensionMcpNames) {
      mcpServers[`nimbalyst-${shortName}`] = makeConfig(
        descriptor.port,
        `/mcp/ext/${shortName}`
      );
    }
    extensionDevPort = resolveExtensionDevPort();
    if (extensionDevPort) {
      mcpServers["nimbalyst-extension-dev"] = makeConfig(
        extensionDevPort,
        "/mcp"
      );
    }
  }
}

const cliVersion = spawnSync(cliPath, ["--version"], {
  encoding: "utf8",
}).stdout.trim();
const sdkVersion = JSON.parse(
  readFileSync(
    join(
      workspacePath,
      "node_modules/@anthropic-ai/claude-agent-sdk/package.json"
    ),
    "utf8"
  )
).version;

const runSummary = {
  profile: profileName,
  components: profile,
  dryRun,
  workspacePath,
  cliPath,
  cliVersion,
  sdkVersion,
  model,
  proxyUrl,
  maxBudgetUsd,
  toolSearch,
  promptBytes: Buffer.byteLength(prompt, "utf8"),
  promptFingerprint: fingerprint(prompt),
  permissionMode: "dontAsk",
  strictMcpConfig: true,
  userMcpConfiguration: "empty",
  noSessionPersistence: true,
  mcpSessionIdSource: configuredMcpSessionId ? "provided" : "random",
  mcpSessionIdFingerprint: configuredMcpSessionId
    ? fingerprint(configuredMcpSessionId)
    : null,
  promptOptions: {
    hasSessionNaming,
    hasOutOfBandNaming,
    trackersEnabled,
    hasWorktreePath: Boolean(worktreePath),
    worktreePathFingerprint: worktreePath ? fingerprint(worktreePath) : null,
    isVoiceMode,
  },
  mcpServerNames: Object.keys(mcpServers),
  extensionDevPort,
  pluginDirs: profile.plugins ? pluginDirs : [],
  addendumBytes: Buffer.byteLength(addendum, "utf8"),
  addendumEstimatedTokens: Math.ceil(Buffer.byteLength(addendum, "utf8") / 4),
  addendumFingerprint: addendum ? fingerprint(addendum) : null,
};

if (dryRun) {
  console.log(JSON.stringify(runSummary, null, 2));
  process.exit(0);
}

const experimentKey = `${profileName}:${runLabel}`;
async function registerExperiment(
  registration: Record<string, unknown>
): Promise<void> {
  const response = await fetch(`${proxyUrl}/__nimbalyst_context_profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  if (!response.ok) {
    throw new Error(
      `Context proxy registration failed: ${
        response.status
      } ${await response.text()}`
    );
  }
}

await registerExperiment({
  phase: "start",
  experimentKey,
  profile: profileName,
  runLabel,
  components: profile,
  model,
  toolSearch,
  promptBytes: runSummary.promptBytes,
  promptFingerprint: runSummary.promptFingerprint,
  addendumBytes: runSummary.addendumBytes,
  addendumFingerprint: runSummary.addendumFingerprint,
  mcpServerNames: runSummary.mcpServerNames,
  pluginDirCount: runSummary.pluginDirs.length,
  promptOptions: runSummary.promptOptions,
  cliVersion,
  sdkVersion,
});

const args = [
  "-p",
  prompt,
  "--model",
  model,
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--mcp-config",
  JSON.stringify({ mcpServers }),
  "--permission-mode",
  "dontAsk",
  ...(profile.addendum ? ["--append-system-prompt", addendum] : []),
  ...(profile.plugins
    ? pluginDirs.flatMap((pluginDir) => ["--plugin-dir", pluginDir])
    : []),
  "--max-budget-usd",
  maxBudgetUsd,
];

const child = spawn(cliPath, args, {
  cwd: workspacePath,
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: proxyUrl,
    ENABLE_TOOL_SEARCH: String(toolSearch),
    CLAUDE_CODE_ENTRYPOINT: "cli",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const exitCode = await new Promise<number | null>((resolve) =>
  child.on("close", resolve)
);
const outputPath = `/tmp/claude-context-overhead-${profileName}-${runLabel}.jsonl`;
writeFileSync(outputPath, stdout);

const events = stdout
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const assistant = events.find(
  (event) => event.type === "assistant" && !event.parent_tool_use_id
);
const usage = assistant?.message?.usage;
const init = events.find(
  (event) => event.type === "system" && event.subtype === "init"
);

const finalSummary = {
  ...runSummary,
  experimentKey,
  runLabel,
  outputPath,
  exitCode,
  stderr: stderr.trim() || undefined,
  claudeCodeVersionFromInit: init?.claude_code_version,
  connectedMcpServers: init?.mcp_servers,
  toolCount: init?.tools?.length,
  slashCommandCount: init?.slash_commands?.length,
  skillCount: init?.skills?.length,
  usage,
  resolvedModel: assistant?.message?.model,
  contextTokens: usage
    ? usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens
    : undefined,
};

try {
  await registerExperiment({
    phase: "complete",
    experimentKey,
    profile: profileName,
    runLabel,
    exitCode,
    usage,
    resolvedModel: finalSummary.resolvedModel,
    contextTokens: finalSummary.contextTokens,
    connectedMcpServers: finalSummary.connectedMcpServers,
    toolCount: finalSummary.toolCount,
    slashCommandCount: finalSummary.slashCommandCount,
    skillCount: finalSummary.skillCount,
  });
} catch (error) {
  console.error(`Failed to register completed experiment: ${String(error)}`);
}

console.log(JSON.stringify(finalSummary, null, 2));

process.exitCode = exitCode ?? 1;
