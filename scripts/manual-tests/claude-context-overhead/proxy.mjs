/**
 * Records privacy-safe structure, sizes, and cache placement of Claude
 * /v1/messages requests, then forwards them to the real Anthropic API
 * unchanged. Request content is represented only by process-scoped HMACs.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { randomBytes, randomUUID } from "node:crypto";

import {
  createRequestSummarizer,
  fingerprintRequestFamily,
  NIMBALYST_APPEND_SYSTEM_PROMPT_MARKER,
  summarizeSseResponse,
} from "./request-summary.mjs";

const port = Number(process.argv[2] || 8377);
const logPath =
  process.env.CLAUDE_CONTEXT_PROXY_LOG ??
  "/tmp/nimbalyst-claude-context-proxy.jsonl";
const upstream = "api.anthropic.com";
const fingerprintKey = randomBytes(32);
const fingerprintRunId = randomUUID();
const requestSummarizers = new Map();
let activeExperiment = null;
let proxyRequestIndex = 0;

function getRequestSummarizer(streamKey) {
  if (!requestSummarizers.has(streamKey)) {
    requestSummarizers.set(
      streamKey,
      createRequestSummarizer({
        fingerprintKey,
        runId: fingerprintRunId,
        // Harness-only instrumentation: split the merged CLI preset from the
        // provider append text in memory. Persist only lengths and HMACs.
        appendSystemPromptMarker: NIMBALYST_APPEND_SYSTEM_PROMPT_MARKER,
      })
    );
  }
  return requestSummarizers.get(streamKey);
}

function appendRecord(record) {
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

http
  .createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (
        request.method === "POST" &&
        request.url === "/__nimbalyst_context_profile"
      ) {
        try {
          const registration = JSON.parse(body.toString("utf8"));
          if (registration.phase === "start") {
            activeExperiment = registration;
          }
          appendRecord({
            recordType: "experiment",
            timestamp: new Date().toISOString(),
            ...registration,
          });
          if (
            registration.phase === "complete" &&
            activeExperiment?.experimentKey === registration.experimentKey
          ) {
            activeExperiment = null;
          }
          response.writeHead(204);
          response.end();
        } catch (error) {
          response.writeHead(400);
          response.end(String(error));
        }
        return;
      }
      let proxiedRequest = null;
      if (
        request.method === "POST" &&
        request.url.includes("/v1/messages") &&
        !request.url.includes("count_tokens")
      ) {
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          const lane = (parsed.tools?.length ?? 0) > 0 ? "agent" : "auxiliary";
          const requestFamilyFingerprint = fingerprintRequestFamily(
            parsed,
            fingerprintKey
          );
          const streamKey = `${requestFamilyFingerprint}:${lane}`;
          const summary = getRequestSummarizer(streamKey).summarize(
            body.toString("utf8")
          );
          proxiedRequest = {
            proxyRequestIndex: proxyRequestIndex++,
            lane,
            requestFamilyFingerprint,
            summary,
            experiment: activeExperiment,
          };
          appendRecord({
            recordType: "request",
            experiment: proxiedRequest.experiment,
            proxyRequestIndex: proxiedRequest.proxyRequestIndex,
            lane,
            requestFamilyFingerprint,
            laneRequestIndex: summary.requestIndex,
            ...summary,
          });
        } catch (error) {
          console.error("Failed to write proxy summary:", error);
        }
      }

      const upstreamRequest = https.request(
        {
          hostname: upstream,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: upstream },
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode,
            upstreamResponse.headers
          );
          if (!proxiedRequest) {
            upstreamResponse.pipe(response);
            return;
          }

          const responseChunks = [];
          upstreamResponse.on("data", (chunk) => {
            response.write(chunk);
            responseChunks.push(chunk);
          });
          upstreamResponse.on("end", () => {
            response.end();
            let responseSummary = {
              model: undefined,
              stopReason: undefined,
              diagnostics: undefined,
              usage: {},
              contextTokens: 0,
            };
            try {
              responseSummary = summarizeSseResponse(
                responseChunks,
                upstreamResponse.headers["content-encoding"]
              );
            } catch (error) {
              console.error("Failed to parse upstream usage:", error.message);
            }
            appendRecord({
              recordType: "response",
              timestamp: new Date().toISOString(),
              experiment: proxiedRequest.experiment,
              proxyRequestIndex: proxiedRequest.proxyRequestIndex,
              lane: proxiedRequest.lane,
              requestFamilyFingerprint: proxiedRequest.requestFamilyFingerprint,
              statusCode: upstreamResponse.statusCode,
              ...responseSummary,
            });
          });
        }
      );
      upstreamRequest.on("error", (error) => {
        console.error("Anthropic upstream error:", error.message);
        response.writeHead(502);
        response.end();
      });
      upstreamRequest.end(body);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Claude context proxy listening on http://127.0.0.1:${port}`);
    console.log(`Writing structural summaries to ${logPath}`);
    console.log(
      `Fingerprint run ${fingerprintRunId}; fingerprints compare only within this proxy process.`
    );
  });
