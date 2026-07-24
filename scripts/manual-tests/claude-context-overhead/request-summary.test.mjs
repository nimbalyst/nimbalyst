import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  createRequestSummarizer,
  fingerprintRequestFamily,
  summarizeSseResponse,
} from "./request-summary.mjs";

const fingerprintKey = Buffer.alloc(32, 7);

function request(overrides = {}) {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 8,
    stream: true,
    system: [
      {
        type: "text",
        text: "private system guidance",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "mcp__nimbalyst__update_session_meta",
        description: "private dynamic description with research (32)",
        input_schema: {
          type: "object",
          properties: {
            add: { type: "array", description: "private tag counts" },
          },
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "private user prompt" }],
      },
    ],
    ...overrides,
  };
}

test("summary never persists private request text", () => {
  const summarizer = createRequestSummarizer({
    fingerprintKey,
    runId: "test-run",
  });
  const summary = summarizer.summarize(JSON.stringify(request()));
  const persisted = JSON.stringify(summary);

  assert.equal(persisted.includes("private system guidance"), false);
  assert.equal(persisted.includes("private dynamic description"), false);
  assert.equal(persisted.includes("private tag counts"), false);
  assert.equal(persisted.includes("private user prompt"), false);
  assert.equal(summary.tools[0].server, "nimbalyst");
  assert.equal(summary.system[0].cacheControl, "ephemeral");
  assert.equal(summary.system[0].cacheControlTtl, "1h");
  assert.equal(
    summary.options.fields.find((field) => field.name === "model").value,
    "claude-haiku-4-5"
  );
});

test("merged system text is split without persisting either segment", () => {
  const summarizer = createRequestSummarizer({
    fingerprintKey,
    runId: "test-run",
  });
  const marker =
    "The following is an addendum to the above. Anything in the addendum supersedes the above.";
  const firstText = `private cli preset\n\n${marker}\nprivate provider append`;
  const secondText = `private cli\n\n${marker}\nprivate provider append`;

  const first = summarizer.summarize(
    JSON.stringify(
      request({
        system: [{ type: "text", text: firstText }],
      })
    )
  );
  const second = summarizer.summarize(
    JSON.stringify(
      request({
        system: [{ type: "text", text: secondText }],
      })
    )
  );
  const composition = second.system[0].textComposition;
  const persisted = JSON.stringify({ first, second });

  assert.equal(composition.appendSystemPromptMarkerFound, true);
  assert.equal(
    first.system[0].textComposition.providerAppendSystemPrompt.fingerprint,
    composition.providerAppendSystemPrompt.fingerprint
  );
  assert.notEqual(
    first.system[0].textComposition.cliPresetRemainder.fingerprint,
    composition.cliPresetRemainder.fingerprint
  );
  assert.deepEqual(second.system[0].textByteDiffFromPrevious, {
    commonPrefixBytes: 11,
    commonSuffixBytes: Buffer.byteLength(
      `\n\n${marker}\nprivate provider append`
    ),
    beforeChangedBytes: 7,
    afterChangedBytes: 0,
    beforeChangedFingerprint:
      second.system[0].textByteDiffFromPrevious.beforeChangedFingerprint,
    afterChangedFingerprint:
      second.system[0].textByteDiffFromPrevious.afterChangedFingerprint,
  });
  assert.equal(persisted.includes("private cli preset"), false);
  assert.equal(persisted.includes("private provider append"), false);
});

test("live request families are stable, private, and session-specific", () => {
  const first = request({
    metadata: { user_id: "private-session-a" },
  });
  const repeat = request({
    metadata: { user_id: "private-session-a" },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "a later private prompt" }],
      },
    ],
  });
  const other = request({
    metadata: { user_id: "private-session-b" },
  });

  const firstFingerprint = fingerprintRequestFamily(first, fingerprintKey);
  assert.equal(
    firstFingerprint,
    fingerprintRequestFamily(repeat, fingerprintKey)
  );
  assert.notEqual(
    firstFingerprint,
    fingerprintRequestFamily(other, fingerprintKey)
  );
  assert.equal(firstFingerprint.includes("private-session"), false);
});

test("fingerprints are stable and changed tool fields are localized", () => {
  const summarizer = createRequestSummarizer({
    fingerprintKey,
    runId: "test-run",
  });
  const first = summarizer.summarize(JSON.stringify(request()));
  const second = summarizer.summarize(JSON.stringify(request()));
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(second.changesFromPrevious.requestChanged, false);

  const changedRequest = request();
  changedRequest.tools[0].input_schema.properties.add.description =
    "different private tag counts";
  const third = summarizer.summarize(JSON.stringify(changedRequest));
  assert.equal(third.changesFromPrevious.requestChanged, true);
  assert.deepEqual(
    third.changesFromPrevious.changedTools.map((tool) => tool.name),
    ["mcp__nimbalyst__update_session_meta"]
  );
  assert.deepEqual(third.changesFromPrevious.changedTools[0].changedPaths, [
    "$.input_schema.properties.add.description",
  ]);
});

test("tool order, system, messages, and options are compared independently", () => {
  const summarizer = createRequestSummarizer({
    fingerprintKey,
    runId: "test-run",
  });
  const firstRequest = request();
  firstRequest.tools.push({ name: "Read", description: "read files" });
  summarizer.summarize(JSON.stringify(firstRequest));

  const secondRequest = request({
    max_tokens: 9,
    system: [{ type: "text", text: "changed private system guidance" }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "changed private prompt" }],
      },
    ],
    tools: [...firstRequest.tools].reverse(),
  });
  const summary = summarizer.summarize(JSON.stringify(secondRequest));

  assert.equal(summary.changesFromPrevious.toolOrderChanged, true);
  assert.equal(summary.changesFromPrevious.serverOrderChanged, true);
  assert.deepEqual(summary.changesFromPrevious.changedOptions, ["max_tokens"]);
  assert.equal(summary.changesFromPrevious.changedSystemBlocks.length, 1);
  assert.deepEqual(
    summary.changesFromPrevious.changedSystemBlocks[0].changedPaths,
    ["$.text", "$.cache_control.type", "$.cache_control.ttl"]
  );
  assert.equal(summary.changesFromPrevious.changedMessageSegments.length, 1);
  assert.deepEqual(
    summary.changesFromPrevious.changedMessageSegments[0].changedPaths,
    ["$.text"]
  );
});

test("compressed SSE usage is captured without response content", () => {
  const sse = [
    `data: ${JSON.stringify({
      type: "message_start",
      message: {
        model: "claude-haiku-4-5-20251001",
        diagnostics: { cache_miss_reason: { type: "tools_changed" } },
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 20,
        },
        content: [{ type: "text", text: "private response content" }],
      },
    })}`,
    `data: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  const summary = summarizeSseResponse([gzipSync(sse)], "gzip");

  assert.equal(summary.contextTokens, 130);
  assert.equal(summary.model, "claude-haiku-4-5-20251001");
  assert.equal(summary.stopReason, "end_turn");
  assert.deepEqual(summary.diagnostics, { cacheMissReason: "tools_changed" });
  assert.equal(
    JSON.stringify(summary).includes("private response content"),
    false
  );
});
