import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const ESTIMATED_BYTES_PER_TOKEN = 4;
export const NIMBALYST_APPEND_SYSTEM_PROMPT_MARKER =
  "The following is an addendum to the above. Anything in the addendum supersedes the above.";
const PRIVATE_SEGMENT_KEYS = new Set(["system", "tools", "messages"]);
const PUBLIC_OPTION_VALUES = new Set([
  "model",
  "max_tokens",
  "stream",
  "temperature",
  "top_k",
  "top_p",
]);

function serialize(value) {
  return JSON.stringify(value);
}

function keyedFingerprint(value, fingerprintKey) {
  return createHmac("sha256", fingerprintKey)
    .update(serialize(value))
    .digest("hex")
    .slice(0, 20);
}

/**
 * Best-effort request-family identity for a live shared proxy. Claude Code keeps
 * metadata stable for requests from one SDK subprocess, including auxiliary
 * control calls, while separate sessions use different metadata. The HMAC is
 * process-scoped and never exposes the metadata value itself.
 */
export function fingerprintRequestFamily(parsed, fingerprintKey) {
  return keyedFingerprint(
    {
      model: parsed?.model ?? null,
      metadata: parsed?.metadata ?? null,
    },
    fingerprintKey
  );
}

function byteLength(value) {
  return Buffer.byteLength(serialize(value), "utf8");
}

function estimatedTokens(bytes) {
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseToolServer(name) {
  if (!name.startsWith("mcp__")) return "builtin";
  return name.split("__", 3)[1] || "unknown";
}

function flattenLeaves(value, fingerprint, path = "$", output = []) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      output.push({
        path,
        type: "array",
        bytes: byteLength(value),
        estimatedTokens: estimatedTokens(byteLength(value)),
        fingerprint: fingerprint(value),
      });
      return output;
    }
    value.forEach((item, index) =>
      flattenLeaves(item, fingerprint, `${path}[${index}]`, output)
    );
    return output;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      output.push({
        path,
        type: "object",
        bytes: byteLength(value),
        estimatedTokens: estimatedTokens(byteLength(value)),
        fingerprint: fingerprint(value),
      });
      return output;
    }
    entries.forEach(([key, item]) =>
      flattenLeaves(item, fingerprint, `${path}.${key}`, output)
    );
    return output;
  }

  const bytes = byteLength(value);
  output.push({
    path,
    type: valueType(value),
    bytes,
    estimatedTokens: estimatedTokens(bytes),
    fingerprint: fingerprint(value),
  });
  return output;
}

function summarizeSegment(value, fingerprint, extra = {}) {
  const bytes = byteLength(value);
  return {
    ...extra,
    bytes,
    estimatedTokens: estimatedTokens(bytes),
    fingerprint: fingerprint(value),
  };
}

function summarizeSystemTextComposition(text, fingerprint, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return { appendSystemPromptMarkerFound: false };
  }

  const cliPresetRemainder = text.slice(0, markerIndex);
  const providerAppendSystemPrompt = text.slice(markerIndex);
  return {
    appendSystemPromptMarkerFound: true,
    cliPresetRemainder: summarizeSegment(cliPresetRemainder, fingerprint),
    providerAppendSystemPrompt: summarizeSegment(
      providerAppendSystemPrompt,
      fingerprint
    ),
  };
}

function summarizeTextByteDiff(previousText, currentText, fingerprint) {
  if (typeof previousText !== "string" || typeof currentText !== "string") {
    return null;
  }

  const before = Buffer.from(previousText, "utf8");
  const after = Buffer.from(currentText, "utf8");
  let commonPrefixBytes = 0;
  while (
    commonPrefixBytes < before.length &&
    commonPrefixBytes < after.length &&
    before[commonPrefixBytes] === after[commonPrefixBytes]
  ) {
    commonPrefixBytes += 1;
  }

  let commonSuffixBytes = 0;
  while (
    commonSuffixBytes < before.length - commonPrefixBytes &&
    commonSuffixBytes < after.length - commonPrefixBytes &&
    before[before.length - 1 - commonSuffixBytes] ===
      after[after.length - 1 - commonSuffixBytes]
  ) {
    commonSuffixBytes += 1;
  }

  const beforeChanged = before.subarray(
    commonPrefixBytes,
    before.length - commonSuffixBytes
  );
  const afterChanged = after.subarray(
    commonPrefixBytes,
    after.length - commonSuffixBytes
  );
  if (beforeChanged.length === 0 && afterChanged.length === 0) return null;

  return {
    commonPrefixBytes,
    commonSuffixBytes,
    beforeChangedBytes: beforeChanged.length,
    afterChangedBytes: afterChanged.length,
    beforeChangedFingerprint: fingerprint(beforeChanged),
    afterChangedFingerprint: fingerprint(afterChanged),
  };
}

function changedLeafPaths(previous, current) {
  const before = new Map(
    (previous?.fieldFingerprints ?? []).map((field) => [
      field.path,
      field.fingerprint,
    ])
  );
  const after = new Map(
    (current?.fieldFingerprints ?? []).map((field) => [
      field.path,
      field.fingerprint,
    ])
  );
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path)
  );
}

function diffByIndex(previous = [], current = []) {
  const length = Math.max(previous.length, current.length);
  const changed = [];
  for (let index = 0; index < length; index += 1) {
    if (previous[index]?.fingerprint !== current[index]?.fingerprint) {
      changed.push({
        index,
        beforeFingerprint: previous[index]?.fingerprint ?? null,
        afterFingerprint: current[index]?.fingerprint ?? null,
        beforeBytes: previous[index]?.bytes ?? 0,
        afterBytes: current[index]?.bytes ?? 0,
        changedPaths: changedLeafPaths(previous[index], current[index]),
      });
    }
  }
  return changed;
}

function compareSummaries(previous, current) {
  if (!previous) return null;

  const previousTools = new Map(
    previous.tools.map((tool) => [tool.name, tool])
  );
  const currentTools = new Map(current.tools.map((tool) => [tool.name, tool]));
  const addedTools = current.toolOrder.filter(
    (name) => !previousTools.has(name)
  );
  const removedTools = previous.toolOrder.filter(
    (name) => !currentTools.has(name)
  );
  const changedTools = current.toolOrder
    .filter(
      (name) =>
        previousTools.has(name) &&
        previousTools.get(name).fingerprint !==
          currentTools.get(name).fingerprint
    )
    .map((name) => ({
      name,
      beforeBytes: previousTools.get(name).bytes,
      afterBytes: currentTools.get(name).bytes,
      beforeFingerprint: previousTools.get(name).fingerprint,
      afterFingerprint: currentTools.get(name).fingerprint,
      changedPaths: changedLeafPaths(
        previousTools.get(name),
        currentTools.get(name)
      ),
    }));

  const previousOptions = new Map(
    previous.options.fields.map((field) => [field.name, field])
  );
  const currentOptions = new Map(
    current.options.fields.map((field) => [field.name, field])
  );
  const changedOptions = [
    ...new Set([...previousOptions.keys(), ...currentOptions.keys()]),
  ].filter(
    (name) =>
      previousOptions.get(name)?.fingerprint !==
      currentOptions.get(name)?.fingerprint
  );

  return {
    requestChanged: previous.fingerprint !== current.fingerprint,
    toolOrderChanged:
      previous.toolOrderFingerprint !== current.toolOrderFingerprint,
    serverOrderChanged:
      previous.serverOrderFingerprint !== current.serverOrderFingerprint,
    addedTools,
    removedTools,
    changedTools,
    changedSystemBlocks: diffByIndex(previous.system, current.system),
    changedMessageSegments: diffByIndex(
      previous.messageSegments,
      current.messageSegments
    ),
    changedOptions,
  };
}

function decodeResponseBody(chunks, contentEncoding) {
  const body = Buffer.concat(chunks);
  const encoding = Array.isArray(contentEncoding)
    ? contentEncoding[0]
    : contentEncoding;
  if (encoding === "gzip") return gunzipSync(body).toString("utf8");
  if (encoding === "br") return brotliDecompressSync(body).toString("utf8");
  if (encoding === "deflate") return inflateSync(body).toString("utf8");
  return body.toString("utf8");
}

export function summarizeSseResponse(chunks, contentEncoding) {
  const usage = {};
  let model;
  let stopReason;
  let diagnostics;
  const decoded = decodeResponseBody(chunks, contentEncoding);

  for (const line of decoded.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event.message?.model) model = event.message.model;
      if (event.message?.usage) Object.assign(usage, event.message.usage);
      if (event.usage) Object.assign(usage, event.usage);
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      if (event.message?.diagnostics) {
        diagnostics = {
          cacheMissReason:
            event.message.diagnostics.cache_miss_reason?.type ?? null,
        };
      }
    } catch {
      // Ignore non-JSON SSE lines. Content is never returned.
    }
  }

  return {
    model,
    stopReason,
    diagnostics,
    usage,
    contextTokens:
      Number(usage.input_tokens ?? 0) +
      Number(usage.cache_creation_input_tokens ?? 0) +
      Number(usage.cache_read_input_tokens ?? 0),
  };
}

export function createRequestSummarizer({
  fingerprintKey = randomBytes(32),
  runId = randomUUID(),
  appendSystemPromptMarker = NIMBALYST_APPEND_SYSTEM_PROMPT_MARKER,
} = {}) {
  let previousSummary;
  let previousSystemTexts = [];
  let requestIndex = 0;
  const fingerprint = (value) => keyedFingerprint(value, fingerprintKey);

  return {
    runId,
    summarize(body) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return {
          timestamp: new Date().toISOString(),
          runId,
          requestIndex: requestIndex++,
          parseError: true,
          bytes: Buffer.byteLength(body, "utf8"),
        };
      }

      const rawSystem = parsed.system;
      const systemValues =
        typeof rawSystem === "string" ? [rawSystem] : rawSystem ?? [];
      const system = systemValues.map((block, index) => {
        const text =
          typeof block === "string"
            ? block
            : typeof block?.text === "string"
            ? block.text
            : undefined;
        const summary = summarizeSegment(block, fingerprint, {
          index,
          type: typeof block === "string" ? "text" : block.type ?? "object",
          cacheControl:
            typeof block === "object"
              ? block.cache_control?.type ?? null
              : null,
          cacheControlTtl:
            typeof block === "object" ? block.cache_control?.ttl ?? null : null,
        });
        return {
          ...summary,
          fieldFingerprints: flattenLeaves(block, fingerprint),
          ...(text === undefined
            ? {}
            : {
                textComposition: summarizeSystemTextComposition(
                  text,
                  fingerprint,
                  appendSystemPromptMarker
                ),
                textByteDiffFromPrevious: summarizeTextByteDiff(
                  previousSystemTexts[index],
                  text,
                  fingerprint
                ),
              }),
        };
      });

      const tools = (parsed.tools ?? []).map((tool, index) => {
        const summary = summarizeSegment(tool, fingerprint, {
          index,
          name: tool.name,
          server: parseToolServer(tool.name),
          cacheControl: tool.cache_control?.type ?? null,
          cacheControlTtl: tool.cache_control?.ttl ?? null,
        });
        return {
          ...summary,
          fieldFingerprints: flattenLeaves(tool, fingerprint),
        };
      });
      const toolOrder = tools.map((tool) => tool.name);
      const serverOrder = [...new Set(tools.map((tool) => tool.server))];
      const servers = serverOrder.map((server, index) => {
        const names = tools
          .filter((tool) => tool.server === server)
          .map((tool) => tool.name);
        return summarizeSegment(names, fingerprint, {
          index,
          server,
          toolCount: names.length,
          toolNames: names,
        });
      });

      const messages = parsed.messages ?? [];
      const messageSegments = messages.flatMap((message, messageIndex) => {
        const blocks = Array.isArray(message.content)
          ? message.content
          : [message.content];
        return blocks.map((block, blockIndex) => {
          const summary = summarizeSegment(block, fingerprint, {
            messageIndex,
            blockIndex,
            role: message.role,
            type: typeof block === "string" ? "text" : block?.type ?? "object",
            cacheControl:
              typeof block === "object"
                ? block?.cache_control?.type ?? null
                : null,
            cacheControlTtl:
              typeof block === "object"
                ? block?.cache_control?.ttl ?? null
                : null,
          });
          return {
            ...summary,
            fieldFingerprints: flattenLeaves(block, fingerprint),
          };
        });
      });

      const optionEntries = Object.entries(parsed).filter(
        ([name]) => !PRIVATE_SEGMENT_KEYS.has(name)
      );
      const optionOrder = optionEntries.map(([name]) => name);
      const options = {
        order: optionOrder,
        orderFingerprint: fingerprint(optionOrder),
        fields: optionEntries.map(([name, value]) => ({
          ...summarizeSegment(value, fingerprint, {
            name,
            type: valueType(value),
          }),
          ...(PUBLIC_OPTION_VALUES.has(name) ? { value } : {}),
        })),
      };

      const bodyBytes = Buffer.byteLength(body, "utf8");
      const summary = {
        timestamp: new Date().toISOString(),
        runId,
        requestIndex: requestIndex++,
        bytes: bodyBytes,
        estimatedTokens: estimatedTokens(bodyBytes),
        estimateBasis: `${ESTIMATED_BYTES_PER_TOKEN} UTF-8 bytes/token heuristic`,
        fingerprint: fingerprint(parsed),
        system,
        systemBytes: system.reduce((total, block) => total + block.bytes, 0),
        systemEstimatedTokens: system.reduce(
          (total, block) => total + block.estimatedTokens,
          0
        ),
        tools,
        toolCount: tools.length,
        toolBytes: tools.reduce((total, tool) => total + tool.bytes, 0),
        toolEstimatedTokens: tools.reduce(
          (total, tool) => total + tool.estimatedTokens,
          0
        ),
        toolOrder,
        toolOrderFingerprint: fingerprint(toolOrder),
        servers,
        serverOrder,
        serverOrderFingerprint: fingerprint(serverOrder),
        messageCount: messages.length,
        messageSegments,
        messageBytes: messageSegments.reduce(
          (total, segment) => total + segment.bytes,
          0
        ),
        messageEstimatedTokens: messageSegments.reduce(
          (total, segment) => total + segment.estimatedTokens,
          0
        ),
        options,
      };
      summary.changesFromPrevious = compareSummaries(previousSummary, summary);
      previousSummary = summary;
      previousSystemTexts = systemValues.map((block) =>
        typeof block === "string"
          ? block
          : typeof block?.text === "string"
          ? block.text
          : undefined
      );
      return summary;
    },
  };
}
