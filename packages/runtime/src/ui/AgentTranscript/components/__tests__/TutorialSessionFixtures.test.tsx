import React from "react";
import * as fs from "fs/promises";
import * as path from "path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  projectRawMessagesToViewMessages,
  type RawMessage,
  type TranscriptViewMessage,
} from "@nimbalyst/runtime/ai/server/transcript";
import {
  AskUserQuestionWidget,
  CrossSessionToolWidget,
  EditorScreenshotWidget,
  TrackerToolWidget,
  VisualDisplayWidget,
  getCustomToolWidget,
} from "@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets";

const FIXTURE_DIRECTORY = path.resolve(
  process.cwd(),
  "packages/electron/resources/tutorial-project/sessions"
);
const TUTORIAL_ROOT = path.resolve("/tmp/Tutorial Fixture Projection");
const DRAFT_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TRIAGE_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const EXAMPLE_BUG_ID = "tk_tutorial_example_bug";
const EXAMPLE_BUG_KEY = "NIM-6";

interface Fixture {
  session: { provider: string; title: string };
  messages: Array<{
    direction: RawMessage["direction"];
    source: string;
    content: string;
    hidden: boolean;
  }>;
}

async function loadAndProject(
  filename: string,
  sessionId: string
): Promise<TranscriptViewMessage[]> {
  const fixture = JSON.parse(
    await fs.readFile(path.join(FIXTURE_DIRECTORY, filename), "utf8")
  ) as Fixture;
  const rawMessages: RawMessage[] = fixture.messages.map((message, index) => ({
    id: index + 1,
    sessionId,
    source: message.source,
    direction: message.direction,
    content: message.content
      .replaceAll("{{TUTORIAL_ROOT}}", TUTORIAL_ROOT)
      .replaceAll("{{SESSION_ID:DRAFT_THE_PRODUCT_BRIEF}}", DRAFT_SESSION_ID)
      .replaceAll("{{SESSION_ID:TRIAGE_THE_LAUNCH_BUG}}", TRIAGE_SESSION_ID)
      .replaceAll("{{TRACKER_ID:EXAMPLE_BUG}}", EXAMPLE_BUG_ID)
      .replaceAll("{{TRACKER_ISSUE_KEY:EXAMPLE_BUG}}", EXAMPLE_BUG_KEY),
    createdAt: new Date(1_800_000_000_000 + index * 1_000),
    hidden: message.hidden,
  }));
  return projectRawMessagesToViewMessages(
    rawMessages,
    fixture.session.provider
  );
}

function toolMessages(messages: TranscriptViewMessage[]) {
  return messages.filter(
    (
      message
    ): message is TranscriptViewMessage & {
      toolCall: NonNullable<TranscriptViewMessage["toolCall"]>;
    } => Boolean(message.toolCall)
  );
}

describe("tutorial session fixtures", () => {
  it("projects the product-brief rich content through the production parser", async () => {
    const messages = toolMessages(
      await loadAndProject("01-draft-product-brief.json", DRAFT_SESSION_ID)
    );
    const byName = new Map(
      messages.map((message) => [message.toolCall.toolName, message])
    );

    expect([...byName.keys()]).toEqual([
      "Edit",
      "mcp__nimbalyst__display_to_user",
      "AskUserQuestion",
      "mcp__nimbalyst__capture_editor_screenshot",
    ]);
    expect(
      messages.every((message) => message.toolCall.status === "completed")
    ).toBe(true);
    expect(getCustomToolWidget("mcp__nimbalyst__display_to_user")).toBe(
      VisualDisplayWidget
    );
    expect(getCustomToolWidget("AskUserQuestion")).toBe(AskUserQuestionWidget);
    expect(
      getCustomToolWidget("mcp__nimbalyst__capture_editor_screenshot")
    ).toBe(EditorScreenshotWidget);
    expect(getCustomToolWidget("Edit")).toBeUndefined();
    expect(byName.get("Edit")?.toolCall.arguments).toMatchObject({
      file_path: path.join(TUTORIAL_ROOT, "product-brief.md"),
      old_string: "The first version is for a team preparing a product launch.",
    });
    expect(
      (
        byName.get("mcp__nimbalyst__display_to_user")?.toolCall.arguments
          .items as Array<{ chart: { data: unknown[] } }>
      )[0].chart.data
    ).toHaveLength(6);

    const question = byName.get("AskUserQuestion");
    expect(question?.toolCall.result).toContain("Revenue momentum");
    render(
      <AskUserQuestionWidget
        message={question!}
        isExpanded={false}
        onToggle={() => undefined}
        sessionId={DRAFT_SESSION_ID}
      />
    );
    expect(screen.getByTestId("ask-user-question-widget").dataset.state).toBe(
      "completed"
    );
    expect(screen.getByTestId("ask-user-question-completed")).toBeDefined();
    expect(screen.queryByTestId("ask-user-question-pending")).toBeNull();

    const screenshot = byName.get("mcp__nimbalyst__capture_editor_screenshot");
    const readFile = vi.fn();
    render(
      <EditorScreenshotWidget
        message={screenshot!}
        isExpanded={false}
        onToggle={() => undefined}
        sessionId={DRAFT_SESSION_ID}
        workspacePath={TUTORIAL_ROOT}
        readFile={readFile}
      />
    );
    const screenshotImage = await screen.findByAltText("dashboard.mockup.html");
    expect(screenshotImage.getAttribute("src")).toContain(
      "data:image/jpeg;base64,"
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("projects tracker and cross-session widgets with completed results", async () => {
    const messages = toolMessages(
      await loadAndProject("02-triage-launch-bug.json", TRIAGE_SESSION_ID)
    );

    expect(messages.map((message) => message.toolCall.toolName)).toEqual([
      "mcp__nimbalyst-trackers__tracker_create",
      "mcp__nimbalyst-trackers__tracker_link_session",
      "mcp__nimbalyst-host__spawn_session",
    ]);
    expect(
      messages.every((message) => message.toolCall.status === "completed")
    ).toBe(true);
    expect(getCustomToolWidget("mcp__nimbalyst-trackers__tracker_create")).toBe(
      TrackerToolWidget
    );
    expect(
      getCustomToolWidget("mcp__nimbalyst-trackers__tracker_link_session")
    ).toBe(TrackerToolWidget);
    expect(getCustomToolWidget("mcp__nimbalyst-host__spawn_session")).toBe(
      CrossSessionToolWidget
    );
    expect(messages.at(-1)?.toolCall.result).toContain(DRAFT_SESSION_ID);
    expect(messages[1]?.toolCall.arguments).toMatchObject({
      trackerId: EXAMPLE_BUG_ID,
    });
  });

  it("ends both sample sessions with the continuation note", async () => {
    const note =
      "Note to the user: You can type into the window below and continue this session or start a new one";
    for (const filename of [
      "01-draft-product-brief.json",
      "02-triage-launch-bug.json",
    ] as const) {
      const fixture = JSON.parse(
        await fs.readFile(path.join(FIXTURE_DIRECTORY, filename), "utf8")
      ) as Fixture;
      const finalPayload = JSON.parse(fixture.messages.at(-1)!.content) as {
        message: { content: Array<{ text?: string }> };
      };
      expect(finalPayload.message.content.at(-1)?.text).toBe(note);
    }
  });

  it("references tutorial files that ship in the materialized project", async () => {
    const resourceRoot = path.resolve(
      process.cwd(),
      "packages/electron/resources/tutorial-project"
    );
    await expect(
      Promise.all(
        [
          "revenue.csv",
          "dashboard.mockup.html",
          "product-brief.md",
          "planning/plan-tutorial-walkthrough.md",
        ].map((relativePath) =>
          fs.access(path.join(resourceRoot, relativePath))
        )
      )
    ).resolves.toHaveLength(4);
  });
});
