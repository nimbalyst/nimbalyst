import { useState, useEffect } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PanelHost } from "@nimbalyst/extension-sdk";
import { ProjectGraphExperience } from "../ProjectGraphExperience";
const mounts = vi.hoisted(() => ({ lab: vi.fn(), legacy: vi.fn() }));
vi.mock("../PrototypeLab", () => ({
  PrototypeLab: () => {
    const [value, setValue] = useState("initial");
    useEffect(() => {
      mounts.lab();
    }, []);
    return (
      <input
        aria-label="Lab state"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  },
}));
vi.mock("../../components/ProjectGraphPanel", () => ({
  ProjectGraphPanel: () => {
    useEffect(() => {
      mounts.legacy();
    }, []);
    return <span>Legacy mounted</span>;
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("retains the lab state and mounts each experience only once when comparing views", () => {
  render(
    <ProjectGraphExperience
      host={{ storage: { get: () => undefined } } as unknown as PanelHost}
    />
  );
  const toggle = () => fireEvent.click(screen.getByRole("button"));
  if (!screen.queryByLabelText("Lab state")) toggle();
  fireEvent.change(screen.getByLabelText("Lab state"), {
    target: { value: "selected source, date and record" },
  });
  toggle();
  toggle();
  expect((screen.getByLabelText("Lab state") as HTMLInputElement).value).toBe(
    "selected source, date and record"
  );
  expect(mounts.lab).toHaveBeenCalledTimes(1);
  expect(mounts.legacy).toHaveBeenCalledTimes(1);
});
