// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InlineFileDiff } from "../PrFileDiff";

afterEach(cleanup);

describe("InlineFileDiff", () => {
  it("renders a complete working-tree unified diff", () => {
    const { container } = render(
      <InlineFileDiff
        filePath="src/example.ts"
        status="modified"
        unifiedDiff={[
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1 +1 @@",
          "-const value = 1;",
          "+const value = 2;",
          "",
        ].join("\n")}
      />
    );

    expect(container.querySelector(".diff-code-delete")?.textContent).toBe(
      "const value = 1;"
    );
    expect(container.querySelector(".diff-code-insert")?.textContent).toBe(
      "const value = 2;"
    );
  });

  it("reports an empty text diff without throwing", () => {
    render(
      <InlineFileDiff filePath="image.png" status="modified" unifiedDiff="" />
    );

    expect(
      screen.getByText("No textual changes to display for this file.")
    ).toBeTruthy();
  });
});
