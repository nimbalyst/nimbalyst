import React, { createRef, useEffect, useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentWorkstreamLayout } from "../AgentWorkstreamLayout";

afterEach(cleanup);

it("keeps the editor DOM and local editing state through placement, hiding, and maximize/restore", () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Editor() {
    const [text, setText] = useState("saved");
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return (
      <textarea
        aria-label="Editor"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }
  const props = {
    panelRef: createRef<HTMLDivElement>(),
    editorRef: createRef<HTMLDivElement>(),
    sessionRef: createRef<HTMLDivElement>(),
    rightPanelRef: createRef<HTMLDivElement>(),
    placement: "above" as const,
    layoutMode: "split" as const,
    editorVisible: true,
    sidebarVisible: true,
    viewerSelected: false,
    sidebarWidth: 300,
    splitRatio: 0.5,
    draggingVertical: false,
    draggingSidebar: false,
    onVerticalResize: vi.fn(),
    onSidebarResize: vi.fn(),
    header: <span>Header</span>,
    editor: <Editor />,
    transcript: <span>Transcript</span>,
    sidebar: <span>Review</span>,
  };
  const view = render(<AgentWorkstreamLayout {...props} />);
  const input = view.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "unsaved edit" } });
  input.setSelectionRange(2, 7);
  for (const state of [
    { placement: "right" as const, viewerSelected: true },
    {
      placement: "right" as const,
      viewerSelected: false,
      editorVisible: false,
    },
    {
      placement: "right" as const,
      viewerSelected: true,
      editorVisible: false,
      sidebarVisible: false,
    },
    {
      placement: "right" as const,
      viewerSelected: true,
      layoutMode: "editor" as const,
      sidebarVisible: false,
    },
    { placement: "right" as const, viewerSelected: true },
    { placement: "above" as const },
  ]) {
    view.rerender(
      <AgentWorkstreamLayout {...props} {...state} editor={<Editor />} />
    );
    expect(view.container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("unsaved edit");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  }
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});
