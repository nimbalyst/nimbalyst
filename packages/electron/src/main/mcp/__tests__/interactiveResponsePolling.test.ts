import { describe, expect, it } from "vitest";

import { findFreshInteractiveResponse } from "../tools/interactiveResponsePolling";

describe("interactive response polling", () => {
  it("ignores a historical AskUserQuestion answer with a reused id", () => {
    const response = findFreshInteractiveResponse([
      {
        createdAt: new Date(1_000),
        content: JSON.stringify({
          type: "ask_user_question_response",
          questionId: "call_reused",
          answers: { choice: "old" },
        }),
      },
      {
        createdAt: new Date(3_000),
        content: JSON.stringify({
          type: "ask_user_question_response",
          questionId: "call_other",
          answers: { choice: "unrelated" },
        }),
      },
    ], {
      expectedType: "ask_user_question_response",
      idFields: ["questionId", "rawQuestionId"],
      acceptedIds: new Set(["call_reused"]),
      notBefore: 2_000,
    });

    expect(response).toBeNull();
  });

  it("returns the newest fresh RequestUserInput response through an id alias", () => {
    const response = findFreshInteractiveResponse([
      {
        createdAt: "1970-01-01T00:00:02.500Z",
        content: JSON.stringify({
          type: "request_user_input_response",
          rawPromptId: "call_prompt",
          answers: { choice: "first" },
        }),
      },
      {
        createdAt: new Date(3_000),
        content: JSON.stringify({
          type: "request_user_input_response",
          promptId: "nimtc|call_prompt|2000|1",
          answers: { choice: "latest" },
        }),
      },
    ], {
      expectedType: "request_user_input_response",
      idFields: ["promptId", "rawPromptId"],
      acceptedIds: new Set(["call_prompt", "nimtc|call_prompt|2000|1"]),
      notBefore: 2_000,
    });

    expect(response?.answers).toEqual({ choice: "latest" });
  });

  it("ignores rows without a trustworthy creation time", () => {
    const response = findFreshInteractiveResponse([
      {
        content: JSON.stringify({
          type: "ask_user_question_response",
          questionId: "call_question",
        }),
      },
    ], {
      expectedType: "ask_user_question_response",
      idFields: ["questionId"],
      acceptedIds: new Set(["call_question"]),
      notBefore: 1,
    });

    expect(response).toBeNull();
  });
});
