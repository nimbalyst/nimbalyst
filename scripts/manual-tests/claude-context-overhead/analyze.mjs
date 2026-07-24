import fs from "node:fs";

const logPath = process.argv[2] ?? "/tmp/nimbalyst-claude-context-proxy.jsonl";

if (!fs.existsSync(logPath)) {
  throw new Error(`Proxy log not found: ${logPath}`);
}

const records = fs
  .readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const completions = new Map(
  records
    .filter(
      (record) =>
        record.recordType === "experiment" && record.phase === "complete"
    )
    .map((record) => [record.experimentKey, record])
);
const responses = new Map(
  records
    .filter((record) => record.recordType === "response")
    .map((record) => [record.proxyRequestIndex, record])
);

const requestRecords = records.filter(
  (record) =>
    record.recordType === "request" && record.experiment?.experimentKey
);
const experimentKeys = [
  ...new Set(requestRecords.map((request) => request.experiment.experimentKey)),
];
const runs = experimentKeys.map((experimentKey) => {
  const experimentRequests = requestRecords.filter(
    (request) => request.experiment.experimentKey === experimentKey
  );
  const agentRequests = experimentRequests.filter(
    (request) => request.lane === "agent" || request.toolCount > 0
  );
  const request = [...agentRequests].sort(
    (left, right) => right.bytes - left.bytes
  )[0];
  const agentResponse = request
    ? responses.get(request.proxyRequestIndex)
    : undefined;
  const auxiliary = experimentRequests
    .filter((candidate) => candidate !== request)
    .map((candidate) => ({
      proxyRequestIndex: candidate.proxyRequestIndex,
      bytes: candidate.bytes,
      estimatedTokens: candidate.estimatedTokens,
      contextTokens: responses.get(candidate.proxyRequestIndex)?.contextTokens,
      usage: responses.get(candidate.proxyRequestIndex)?.usage,
    }));
  const completion = completions.get(experimentKey);
  return {
    experimentKey,
    profile: experimentRequests[0].experiment.profile,
    runLabel: experimentRequests[0].experiment.runLabel,
    resolvedModel: agentResponse?.model ?? completion?.resolvedModel,
    contextTokens: agentResponse?.contextTokens ?? completion?.contextTokens,
    usage: agentResponse?.usage ?? completion?.usage,
    auxiliary,
    auxiliaryContextTokens: auxiliary.reduce(
      (sum, item) => sum + Number(item.contextTokens ?? 0),
      0
    ),
    requestCount: experimentRequests.length,
    connectedMcpServers: completion?.connectedMcpServers,
    toolCountFromInit: completion?.toolCount,
    slashCommandCount: completion?.slashCommandCount,
    skillCount: completion?.skillCount,
    request,
  };
});

const profiles = [...new Set(runs.map((run) => run.profile))].map((profile) => {
  const profileRuns = runs.filter((run) => run.profile === profile);
  const actual = profileRuns
    .map((run) => run.contextTokens)
    .filter((value) => Number.isFinite(value));
  const estimated = profileRuns.map((run) => run.request.estimatedTokens);
  const auxiliary = profileRuns.map((run) => run.auxiliaryContextTokens);
  return {
    profile,
    repeats: profileRuns.length,
    actualContextTokens: actual,
    actualContextTokensMean: actual.length
      ? Math.round(
          actual.reduce((sum, value) => sum + value, 0) / actual.length
        )
      : null,
    actualContextTokensRange: actual.length
      ? [Math.min(...actual), Math.max(...actual)]
      : null,
    estimatedRequestTokens: estimated,
    estimatedRequestTokensMean: estimated.length
      ? Math.round(
          estimated.reduce((sum, value) => sum + value, 0) / estimated.length
        )
      : null,
    auxiliaryContextTokens: auxiliary,
    auxiliaryContextTokensMean: auxiliary.length
      ? Math.round(
          auxiliary.reduce((sum, value) => sum + value, 0) / auxiliary.length
        )
      : null,
    requestsPerRun: profileRuns.map((run) => run.requestCount),
    requestBytes: profileRuns.map((run) => run.request.bytes),
    toolCounts: profileRuns.map((run) => run.request.toolCount),
    serverOrders: profileRuns.map((run) => run.request.serverOrder),
  };
});

const rawMean = profiles.find(
  (profile) => profile.profile === "raw"
)?.actualContextTokensMean;
for (const profile of profiles) {
  profile.actualDeltaFromRaw =
    rawMean !== undefined &&
    rawMean !== null &&
    profile.actualContextTokensMean !== null
      ? profile.actualContextTokensMean - rawMean
      : null;
}

const raw = runs.find((run) => run.profile === "raw")?.request;
const full = runs.find((run) => run.profile === "full")?.request;
let fullVsRaw = null;

if (raw && full) {
  const rawTools = new Map(raw.tools.map((tool) => [tool.name, tool]));
  const addedTools = full.tools
    .filter((tool) => !rawTools.has(tool.name))
    .sort((left, right) => right.bytes - left.bytes)
    .map((tool) => ({
      name: tool.name,
      server: tool.server,
      bytes: tool.bytes,
      estimatedTokens: tool.estimatedTokens,
      fingerprint: tool.fingerprint,
    }));
  const serverBillOfMaterials = full.servers
    .filter((server) => server.server !== "builtin")
    .map((server) => {
      const serverTools = full.tools.filter(
        (tool) => tool.server === server.server && !rawTools.has(tool.name)
      );
      return {
        server: server.server,
        toolCount: serverTools.length,
        bytes: serverTools.reduce((sum, tool) => sum + tool.bytes, 0),
        estimatedTokens: serverTools.reduce(
          (sum, tool) => sum + tool.estimatedTokens,
          0
        ),
        membershipFingerprint: server.fingerprint,
      };
    })
    .sort((left, right) => right.bytes - left.bytes);

  fullVsRaw = {
    requestBytesDelta: full.bytes - raw.bytes,
    estimatedRequestTokensDelta: full.estimatedTokens - raw.estimatedTokens,
    systemBytesDelta: full.systemBytes - raw.systemBytes,
    systemEstimatedTokensDelta:
      full.systemEstimatedTokens - raw.systemEstimatedTokens,
    toolBytesDelta: full.toolBytes - raw.toolBytes,
    toolEstimatedTokensDelta:
      full.toolEstimatedTokens - raw.toolEstimatedTokens,
    messageBytesDelta: full.messageBytes - raw.messageBytes,
    messageEstimatedTokensDelta:
      full.messageEstimatedTokens - raw.messageEstimatedTokens,
    toolOrderFingerprint: full.toolOrderFingerprint,
    serverOrder: full.serverOrder,
    serverOrderFingerprint: full.serverOrderFingerprint,
    addedTools,
    serverBillOfMaterials,
    fullSystemBlocks: full.system,
    rawSystemBlocks: raw.system,
    fullMessageSegments: full.messageSegments,
    rawMessageSegments: raw.messageSegments,
    fullOptions: full.options,
    rawOptions: raw.options,
  };
}

console.log(
  JSON.stringify(
    {
      logPath,
      estimateBasis:
        "Structural estimates use 4 UTF-8 bytes/token; actualContextTokens comes from Anthropic usage and is authoritative for case comparisons.",
      runCount: runs.length,
      runs: runs.map((run) => ({
        experimentKey: run.experimentKey,
        profile: run.profile,
        runLabel: run.runLabel,
        resolvedModel: run.resolvedModel,
        contextTokens: run.contextTokens,
        auxiliaryContextTokens: run.auxiliaryContextTokens,
        requestCount: run.requestCount,
        requestBytes: run.request.bytes,
        estimatedRequestTokens: run.request.estimatedTokens,
        requestToolCount: run.request.toolCount,
        toolCountFromInit: run.toolCountFromInit,
        slashCommandCount: run.slashCommandCount,
        skillCount: run.skillCount,
        connectedMcpServers: run.connectedMcpServers,
      })),
      profiles,
      fullVsRaw,
    },
    null,
    2
  )
);
