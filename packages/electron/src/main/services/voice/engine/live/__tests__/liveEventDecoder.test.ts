// @vitest-environment node
import { describe, expect, it } from "vitest";
import startup from "./fixtures/live/startup.json";
import error from "./fixtures/live/error.json";
import audioTranscripts from "./fixtures/live/audio-transcripts.json";
import delegation from "./fixtures/live/delegated-tool-call.json";
import lateResults from "./fixtures/live/late-duplicate-result.json";
import closure from "./fixtures/live/closure.json";
import usage from "./fixtures/live/usage.json";
import overlapping from "./fixtures/live/overlapping-delegations.json";
import afterClose from "./fixtures/live/result-after-close.json";
import {
  acceptToolResult,
  createToolCallState,
  createTranscriptState,
  createUsageState,
  decode,
  markUsageTransportEnded,
  markToolResultsSent,
  reduceToolCalls,
  reduceTranscript,
  reduceUsage,
  splitTranscriptGroup,
  supersedeToolCalls,
  takeReadyToolResults,
} from "../liveEventDecoder";
import type {
  LiveServerEvent,
  LiveTranscriptDeltaEvent,
} from "../liveProtocol";

function event(raw: unknown): LiveServerEvent {
  const decoded = decode(raw);
  if (decoded.kind !== "event") throw new Error(JSON.stringify(decoded));
  return decoded.event;
}

describe("Live protocol reducers", () => {
  it("fails visibly on overlapping delegations and never revives results after closure", () => {
    let state = createToolCallState();
    for (const raw of overlapping.events.slice(0, 5))
      state = reduceToolCalls(state, event(raw)).state;
    const overlap = reduceToolCalls(state, event(overlapping.events[5]));
    expect(overlap).toMatchObject({
      status: "invalid",
      calls: [],
      error: { code: "overlappingResponses" },
    });
    state = overlap.state;
    for (const raw of overlapping.events.slice(6)) {
      const result = reduceToolCalls(state, event(raw));
      expect(result.status).toBe("invalid");
      expect(result.calls).toEqual([]);
      state = result.state;
    }
    for (const result of overlapping.results) {
      state = acceptToolResult(state, result.identity, result.output).state;
      expect(takeReadyToolResults(state)).toMatchObject({
        status: "invalid",
        events: [],
      });
    }
    state = afterClose.events.reduce(
      (previous, raw) => reduceToolCalls(previous, event(raw)).state,
      createToolCallState()
    );
    expect(
      acceptToolResult(
        state,
        afterClose.result.identity,
        afterClose.result.output
      ).status
    ).toBe("stale");
    expect(takeReadyToolResults(state).events).toEqual([]);
    expect(reduceToolCalls(state, event(overlapping.events[5]))).toMatchObject({
      status: "invalid",
      calls: [],
    });
  });

  it("collects complete items, retains calls despite empty terminal output, and emits results exactly once", () => {
    let state = createToolCallState();
    for (const raw of delegation.slice(0, 4)) {
      const result = reduceToolCalls(state, event(raw));
      state = result.state;
      expect(result.calls).toEqual([]);
    }
    const collected = reduceToolCalls(state, event(delegation[4]));
    expect(collected.calls).toMatchObject([
      {
        delegationId: "delegation_1",
        responseId: "resp_1",
        callId: "call_1",
        name: "open_file",
        arguments: '{"path":"README.md"}',
      },
    ]);
    state = acceptToolResult(
      collected.state,
      collected.calls[0],
      '{"opened":true}'
    ).state;
    expect(takeReadyToolResults(state).events).toEqual([]);
    state = reduceToolCalls(state, event(delegation[5])).state;
    expect(reduceToolCalls(state, event(delegation[4])).calls).toEqual([]);
    const ready = takeReadyToolResults(state);
    expect(ready.events).toEqual([
      {
        type: "response.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"opened":true}',
        },
      },
      { type: "response.create" },
    ]);
    expect(takeReadyToolResults(ready.state).events).toEqual([]);
    expect(
      acceptToolResult(ready.state, collected.calls[0], "different result")
        .status
    ).toBe("duplicate");
    expect(collected.state.responses[0].calls[0].output).toBeUndefined();
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready")
      throw new Error("Expected bound result batch");
    expect(ready.binding).toEqual({
      delegationId: "delegation_1",
      responseId: "resp_1",
    });
    // Producing an outbox does not release the serialization lock before transport sends it.
    expect(
      reduceToolCalls(ready.state, event(lateResults.events[1])).status
    ).toBe("invalid");
    const sent = markToolResultsSent(ready.state, ready.binding);
    expect(reduceToolCalls(sent, event(lateResults.events[1])).status).toBe(
      "valid"
    );
  });

  it("requires every parallel result and rejects late results from superseded response identities", () => {
    let state = delegation.reduce(
      (previous, raw) => reduceToolCalls(previous, event(raw)).state,
      createToolCallState()
    );
    const [oldResult, currentResult] = lateResults.results;
    const superseded = supersedeToolCalls(state, "resp_1");
    expect(
      acceptToolResult(superseded, oldResult.identity, oldResult.output).status
    ).toBe("stale");
    expect(
      reduceToolCalls(superseded, event(lateResults.events[1])).status
    ).toBe("invalid");
    const ready = takeReadyToolResults(
      acceptToolResult(state, oldResult.identity, oldResult.output).state
    );
    if (ready.status !== "ready")
      throw new Error("Expected first response batch");
    state = markToolResultsSent(ready.state, ready.binding);
    state = supersedeToolCalls(state, "resp_1");
    for (const raw of lateResults.events)
      state = reduceToolCalls(state, event(raw)).state;
    expect(
      acceptToolResult(state, oldResult.identity, oldResult.output).status
    ).toBe("stale");
    expect(
      acceptToolResult(
        state,
        { ...currentResult.identity, delegationId: "wrong" },
        currentResult.output
      ).status
    ).toBe("unknown");
    const accepted = acceptToolResult(
      state,
      currentResult.identity,
      currentResult.output
    );
    expect(accepted.status).toBe("accepted");
    expect(takeReadyToolResults(accepted.state).events).toHaveLength(2);
    expect(
      acceptToolResult(
        supersedeToolCalls(state, "resp_2"),
        currentResult.identity,
        "late"
      ).status
    ).toBe("stale");

    state = delegation
      .slice(0, 5)
      .reduce(
        (previous, raw) => reduceToolCalls(previous, event(raw)).state,
        createToolCallState()
      );
    const first = state.responses[0].calls[0];
    const secondRaw = {
      ...delegation[4],
      event_id: "parallel_call",
      event: {
        type: "response.output_item.done",
        sequence_number: 6,
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_2",
          call_id: "call_2",
          name: "open_file",
          arguments: '{"path":"docs/VOICE_MODE.md"}',
          status: "completed",
        },
      },
    };
    const second = reduceToolCalls(state, event(secondRaw));
    state = reduceToolCalls(second.state, event(delegation[5])).state;
    state = acceptToolResult(state, first, "one").state;
    expect(takeReadyToolResults(state).events).toEqual([]);
    state = acceptToolResult(state, second.calls[0], "two").state;
    expect(takeReadyToolResults(state).events).toHaveLength(3);
    const closed = reduceToolCalls(state, event(closure)).state;
    expect(takeReadyToolResults(closed).events).toEqual([]);
  });

  it("does not execute malformed, incomplete, uncorrelated or unwrapped calls", () => {
    const done = delegation[4];
    const nested = done.event!;
    expect(decode(nested).kind).toBe("unknown");
    expect(
      decode({
        ...done,
        event: {
          ...nested,
          item: { type: "function_call", id: "fc", arguments: "{}" },
        },
      }).kind
    ).toBe("invalid");
    expect(
      reduceToolCalls(
        createToolCallState(),
        event({ ...done, delegation_id: null })
      ).calls
    ).toEqual([]);
    const unknown = event({
      type: "response.event",
      event_id: "future",
      event: { type: "response.future_event", value: 1 },
    });
    expect(reduceToolCalls(createToolCallState(), unknown).calls).toEqual([]);
    const state = delegation
      .slice(0, 4)
      .reduce(
        (previous, raw) => reduceToolCalls(previous, event(raw)).state,
        createToolCallState()
      );
    expect(
      reduceToolCalls(
        state,
        event({
          ...done,
          event: { ...nested, item: { ...nested.item, status: "incomplete" } },
        })
      ).calls
    ).toEqual([]);
    expect(
      decode({ ...error, error: { ...error.error, message: 42 } }).kind
    ).toBe("invalid");
    expect(event(error)).toMatchObject({
      error: { code: null, client_event_id: "result_1" },
    });
  });

  it("uses cumulative duration, keeps compaction ratios and backend usage separate, and confirms only final events", () => {
    let state = reduceUsage(createUsageState(), event(startup[1]));
    for (const raw of usage) state = reduceUsage(state, event(raw));
    expect(state).toMatchObject({
      seconds: 24,
      contextUsageRatio: 0.2,
      finalized: false,
    });
    state = reduceUsage(state, event(delegation[5]));
    state = reduceUsage(state, event(delegation[5]));
    expect(state.backend).toHaveLength(1);
    expect(state.backend[0]).toMatchObject({
      responseId: "resp_1",
      delegationId: "delegation_1",
      usage: { total_tokens: 150 },
    });
    const lost = markUsageTransportEnded(state);
    expect(lost).toMatchObject({
      seconds: 24,
      finalized: false,
      finalizationMissing: true,
    });
    const finalized = reduceUsage(lost, event(closure));
    expect(finalized).toMatchObject({
      seconds: 27,
      finalized: true,
      finalizationMissing: false,
    });
    expect(markUsageTransportEnded(finalized)).toBe(finalized);
    expect(reduceUsage(finalized, event(usage[0]))).toBe(finalized);
    expect(decode({ ...usage[0], usage: { seconds: -1 } }).kind).toBe(
      "invalid"
    );
  });

  it("upserts stable speaker rows through overlap, long gaps, explicit display splits and late replay", () => {
    const fragments = audioTranscripts
      .map(event)
      .filter(
        (value): value is LiveTranscriptDeltaEvent =>
          value.type === "session.input_transcript.delta" ||
          value.type === "session.output_transcript.delta"
      );
    let state = createTranscriptState("live_fixture_1");
    for (const fragment of fragments.slice(0, 5))
      state = reduceTranscript(state, fragment);
    expect(state.groups).toHaveLength(2); // The 18-second gap is not a turn boundary.
    const [userId, assistantId] = state.groups.map((group) => group.id);
    state = splitTranscriptGroup(state, "assistant", 21000);
    const splitState = state;
    for (const fragment of fragments.slice(5))
      state = reduceTranscript(state, fragment);
    expect(state.groups.map((group) => group.id)).toEqual(
      splitState.groups.map((group) => group.id)
    );
    expect(state.groups.find((group) => group.id === assistantId)?.text).toBe(
      "I can help. Yes."
    );
    expect(state.groups.find((group) => group.id === userId)?.text).toBe(
      "Open that file. Again. no no no no"
    );
    expect(state.groups[2].text).toBe("Resuming.");
    expect(state.groups.flatMap((group) => group.fragments)).toHaveLength(
      fragments.length - 1
    );
    expect(reduceTranscript(state, fragments[7])).toBe(state);
    expect(splitState.groups[1].text).toBe("I can help.");
    // Retroactive display splitting moves each fragment once without changing old row IDs.
    const revised = splitTranscriptGroup(state, "user", 20000);
    expect(revised.groups[0].id).toBe(userId);
    expect(revised.groups[0].text).toBe("Open that file.");
    expect(revised.groups.flatMap((group) => group.fragments)).toHaveLength(
      fragments.length - 1
    );
  });
});
