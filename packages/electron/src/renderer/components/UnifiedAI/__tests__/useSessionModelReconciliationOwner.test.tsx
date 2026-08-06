import type { ReactNode } from "react";
import { Provider, createStore } from "jotai";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  sessionModelReconciliationGateAtom,
  sessionStoreAtom,
} from "../../../store/atoms/sessions";
import { useSessionModelReconciliationOwner } from "../useSessionModelReconciliationOwner";

const marker = {
  status: "pending" as const,
  targetModel: "model-b",
  targetControls: { effortLevel: "high", thinkingMode: "enabled" },
  previousModel: "model-a",
  previousControls: { effortLevel: "low", thinkingMode: "disabled" },
};

function sessionWithMarker(value: unknown) {
  return {
    metadata: { modelChangeReconciliation: value },
  } as never;
}

describe("useSessionModelReconciliationOwner", () => {
  it("fails closed only for the affected session and exposes a bounded retry", async () => {
    const store = createStore();
    store.set(sessionStoreAtom("affected"), sessionWithMarker(marker));
    store.set(sessionStoreAtom("other"), sessionWithMarker(null));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const affectedRecovery = vi
      .fn()
      .mockRejectedValue(new Error("private transport detail"));

    const affected = renderHook(
      () => useSessionModelReconciliationOwner("affected", affectedRecovery),
      { wrapper }
    );
    const other = renderHook(
      () => useSessionModelReconciliationOwner("other", vi.fn()),
      { wrapper }
    );

    await waitFor(() =>
      expect(affected.result.current.gate.status).toBe("required")
    );
    expect(affected.result.current.blocked).toBe(true);
    expect(other.result.current.blocked).toBe(false);
    expect(affectedRecovery).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(affected.result.current.gate)).not.toContain(
      "private transport detail"
    );

    await act(async () => {
      await affected.result.current.retry();
    });
    expect(affectedRecovery).toHaveBeenCalledTimes(2);
    expect(
      store.get(sessionModelReconciliationGateAtom("affected")).status
    ).toBe("required");
  });

  it("owns a pre-existing marker across remount and clears the gate after convergence", async () => {
    const store = createStore();
    store.set(sessionStoreAtom("session-a"), sessionWithMarker(marker));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const firstRecovery = vi.fn().mockRejectedValue(new Error("offline"));
    const firstMount = renderHook(
      () => useSessionModelReconciliationOwner("session-a", firstRecovery),
      { wrapper }
    );

    await waitFor(() =>
      expect(firstMount.result.current.gate.status).toBe("required")
    );
    firstMount.unmount();

    const recovered = vi.fn().mockImplementation(async () => {
      store.set(sessionStoreAtom("session-a"), sessionWithMarker(null));
    });
    const remount = renderHook(
      () => useSessionModelReconciliationOwner("session-a", recovered),
      { wrapper }
    );

    await waitFor(() => expect(remount.result.current.blocked).toBe(false));
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(store.get(sessionModelReconciliationGateAtom("session-a"))).toEqual({
      status: "idle",
    });
  });
});
