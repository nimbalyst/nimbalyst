// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogControlSelector } from "../CatalogControlSelector";

vi.mock("@nimbalyst/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nimbalyst/runtime")>()),
  MaterialSymbol: () => null,
}));

afterEach(cleanup);

describe("CatalogControlSelector", () => {
  it("uses the default only when the persisted value is absent and preserves four-value ordering", async () => {
    const onValueChange = vi.fn();
    render(
      <CatalogControlSelector
        control={{
          id: "reasoning",
          persistenceKey: "reasoning-mode",
          displayLabel: "Reasoning",
          helpText: "Controls reasoning mode.",
          allowedValues: ["none", "high", "max", "ultra"],
          defaultValue: "high",
          valueLabels: {
            '"none"': "None",
            '"high"': "High",
            '"max"': "Max",
            '"ultra"': "Ultra",
          },
        }}
        value={undefined}
        onValueChange={onValueChange}
      />
    );

    const trigger = screen.getByTestId("catalog-control-reasoning-mode");
    expect(trigger.getAttribute("aria-label")).toBe("Reasoning: High");
    fireEvent.click(trigger);
    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["None", "High", "Max", "Ultra"]);
  });

  it("renders invalid persistence as unavailable and emits only allowed values", async () => {
    const onValueChange = vi.fn();
    render(
      <CatalogControlSelector
        control={{
          id: "effort",
          persistenceKey: "effort-level",
          displayLabel: "Effort",
          helpText: "Controls reviewed reasoning effort.",
          allowedValues: ["high", "max"],
          defaultValue: "high",
          valueLabels: { '"high"': "High", '"max"': "Max" },
        }}
        value="low"
        onValueChange={onValueChange}
      />
    );

    const trigger = screen.getByTestId("catalog-control-effort-level");
    expect(trigger.getAttribute("aria-label")).toBe("Effort: Unavailable");
    expect(trigger.getAttribute("title")).toBe(
      "Controls reviewed reasoning effort."
    );
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "Max" }));
    expect(onValueChange).toHaveBeenCalledWith("max");
  });

  it("implements listbox focus, arrow, selection, and Escape semantics", async () => {
    const onValueChange = vi.fn();
    render(
      <CatalogControlSelector
        control={{
          id: "effort",
          persistenceKey: "effort-level",
          displayLabel: "Effort",
          helpText: "Controls reviewed reasoning effort.",
          allowedValues: ["high", "max"],
          defaultValue: "high",
          valueLabels: { '"high"': "High", '"max"': "Max" },
        }}
        value="high"
        onValueChange={onValueChange}
      />
    );

    const trigger = screen.getByTestId("catalog-control-effort-level");
    fireEvent.click(trigger);
    const listbox = await screen.findByRole("listbox");
    const high = screen.getByRole("option", { name: "High" });
    const max = screen.getByRole("option", { name: "Max" });
    expect(high.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(high));

    fireEvent.keyDown(high, { key: "ArrowDown" });
    expect(document.activeElement).toBe(max);
    fireEvent.keyDown(max, { key: "ArrowUp" });
    expect(document.activeElement).toBe(high);
    fireEvent.keyDown(high, { key: "End" });
    expect(document.activeElement).toBe(max);
    fireEvent.keyDown(max, { key: "Home" });
    expect(document.activeElement).toBe(high);
    fireEvent.keyDown(high, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await screen.findByRole("listbox");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("option", { name: "High" })
      )
    );
    fireEvent.keyDown(screen.getByRole("option", { name: "High" }), {
      key: "ArrowDown",
    });
    fireEvent.keyDown(screen.getByRole("option", { name: "Max" }), {
      key: " ",
    });
    expect(onValueChange).toHaveBeenCalledWith("max");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await screen.findByRole("listbox");
    fireEvent.keyDown(screen.getByRole("option", { name: "High" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(listbox).not.toBeNull();
  });
});
