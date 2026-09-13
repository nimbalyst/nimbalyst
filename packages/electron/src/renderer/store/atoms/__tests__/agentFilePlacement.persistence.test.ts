// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { store } from "@nimbalyst/runtime/store";
import {
  AGENT_FILE_PLACEMENT_KEY,
  agentFilePlacementAtom,
  initAgentFilePlacement,
  setAgentFilePlacementAtom,
} from "../agentFilePlacement";

afterEach(() => vi.unstubAllGlobals());

it("loads the personal preference, persists a move, and follows other windows without echoing writes", async () => {
  let listener: (payload: { key: string; value: unknown }) => void = () => {};
  const invoke = vi.fn().mockResolvedValue("right");
  const subscribe = vi.fn((fn: typeof listener) => {
    listener = fn;
    return vi.fn();
  });
  vi.stubGlobal("electronAPI", undefined);
  window.electronAPI = {
    invoke,
    onAppSettingsChanged: subscribe,
  } as unknown as typeof window.electronAPI;
  await initAgentFilePlacement();
  await initAgentFilePlacement();
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(store.get(agentFilePlacementAtom)).toBe("right");
  store.set(setAgentFilePlacementAtom, "above");
  expect(invoke).toHaveBeenCalledWith(
    "app-settings:set",
    AGENT_FILE_PLACEMENT_KEY,
    "above"
  );
  invoke.mockClear();
  listener({ key: AGENT_FILE_PLACEMENT_KEY, value: "right" });
  expect(store.get(agentFilePlacementAtom)).toBe("right");
  expect(invoke).not.toHaveBeenCalled();
  listener({ key: AGENT_FILE_PLACEMENT_KEY, value: "invalid" });
  expect(store.get(agentFilePlacementAtom)).toBe("above");
});
