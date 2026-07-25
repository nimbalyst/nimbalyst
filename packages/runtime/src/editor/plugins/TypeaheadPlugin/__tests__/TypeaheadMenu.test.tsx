import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  TypeaheadMenuContent,
  type TypeaheadMenuOption,
} from "../TypeaheadMenu";

describe("TypeaheadMenuContent", () => {
  it("portals outside the editor scroller so the menu is not clipped", async () => {
    const editorScroller = document.createElement("div");
    editorScroller.dataset.testid = "editor-scroller";
    editorScroller.style.overflow = "auto";
    document.body.appendChild(editorScroller);

    const option: TypeaheadMenuOption = {
      id: "shared-document",
      label: "Features/a-long-shared-document-name.md",
      onSelect: () => {},
    };

    render(
      <TypeaheadMenuContent
        resolution={{
          getRect: () =>
            DOMRect.fromRect({ x: 640, y: 64, width: 1, height: 24 }),
        }}
        options={[option]}
        selectedIndex={0}
        onSelectOption={() => {}}
        onSetSelectedIndex={() => {}}
        anchorElem={editorScroller}
        minWidth={350}
        maxWidth={500}
        maxHeight={400}
      />,
      { container: editorScroller }
    );

    const menu = await screen.findByRole("listbox");
    expect(editorScroller.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });
});
