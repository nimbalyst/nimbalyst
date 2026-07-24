import fs from "node:fs";

const logPath = process.argv[2] ?? "/tmp/nimbalyst-claude-context-proxy.jsonl";
const requestedFamily = process.argv[3];

if (!fs.existsSync(logPath)) {
  throw new Error(`Proxy log not found: ${logPath}`);
}

const records = fs
  .readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const responses = new Map(
  records
    .filter((record) => record.recordType === "response")
    .map((record) => [record.proxyRequestIndex, record])
);
const requests = records.filter(
  (record) => record.recordType === "request" && record.requestFamilyFingerprint
);
const families = [
  ...new Set(requests.map((request) => request.requestFamilyFingerprint)),
]
  .filter((family) => !requestedFamily || family === requestedFamily)
  .map((family) => {
    const familyRequests = requests.filter(
      (request) => request.requestFamilyFingerprint === family
    );
    const firstModel = familyRequests
      .flatMap((request) => request.options?.fields ?? [])
      .find((field) => field.name === "model")?.value;
    return {
      requestFamilyFingerprint: family,
      model: firstModel,
      requestCount: familyRequests.length,
      lanes: [...new Set(familyRequests.map((request) => request.lane))],
      requests: familyRequests.map((request) => {
        const response = responses.get(request.proxyRequestIndex);
        return {
          proxyRequestIndex: request.proxyRequestIndex,
          lane: request.lane,
          laneRequestIndex: request.laneRequestIndex,
          requestBytes: request.bytes,
          systemBytes: request.systemBytes,
          toolBytes: request.toolBytes,
          messageBytes: request.messageBytes,
          toolCount: request.toolCount,
          contextTokens: response?.contextTokens,
          usage: response?.usage,
          cacheMissReason: response?.diagnostics?.cacheMissReason,
          changesFromPrevious: request.changesFromPrevious,
        };
      }),
    };
  });

console.log(
  JSON.stringify(
    {
      logPath,
      familyCount: families.length,
      families,
    },
    null,
    2
  )
);
