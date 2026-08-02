import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  sessionModelReconciliationGateAtom,
  sessionModelReconciliationMarkerAtom,
} from "../../store/atoms/sessions";
import {
  parseSessionModelChangeReconciliation,
  type DurableSessionModelChangeReconciliation,
} from "./latestModelChangeCoordinator";

const RECOVERING_MESSAGE = "Restoring this session's model settings…";
const REQUIRED_MESSAGE =
  "Model settings are not synchronized. Retry recovery before continuing.";
const INVALID_MESSAGE =
  "Model recovery data is invalid. This session is paused for safety.";

export function useSessionModelReconciliationOwner(
  sessionId: string,
  onRecover: (marker: DurableSessionModelChangeReconciliation) => Promise<void>
) {
  const rawMarker = useAtomValue(
    sessionModelReconciliationMarkerAtom(sessionId)
  );
  const gate = useAtomValue(sessionModelReconciliationGateAtom(sessionId));
  const setGate = useSetAtom(sessionModelReconciliationGateAtom(sessionId));
  const jotaiStore = useStore();
  const recoverRef = useRef(onRecover);
  recoverRef.current = onRecover;

  const marker = useMemo(
    () => parseSessionModelChangeReconciliation(rawMarker),
    [rawMarker]
  );
  const markerSignature = useMemo(() => {
    if (rawMarker === null) return "none";
    try {
      return JSON.stringify(rawMarker);
    } catch {
      return "invalid";
    }
  }, [rawMarker]);

  const retry = useCallback(async () => {
    if (!marker) {
      setGate(
        rawMarker === null
          ? { status: "idle" }
          : { status: "required", message: INVALID_MESSAGE }
      );
      return;
    }
    setGate({ status: "recovering", message: RECOVERING_MESSAGE });
    try {
      await recoverRef.current(marker);
      // A resolved callback is not proof of durable convergence. Re-read the
      // mounted store and only release controls after the committed marker is
      // actually gone; a later store rerender will clear a temporarily-required
      // gate through the effect below.
      setGate(
        jotaiStore.get(sessionModelReconciliationMarkerAtom(sessionId)) === null
          ? { status: "idle" }
          : { status: "required", message: REQUIRED_MESSAGE }
      );
    } catch {
      setGate({ status: "required", message: REQUIRED_MESSAGE });
    }
  }, [jotaiStore, marker, rawMarker, sessionId, setGate]);
  const requireRecovery = useCallback(() => {
    setGate({ status: "required", message: REQUIRED_MESSAGE });
  }, [setGate]);

  useEffect(() => {
    if (rawMarker === null) {
      setGate({ status: "idle" });
      return;
    }
    if (!marker) {
      setGate({ status: "required", message: INVALID_MESSAGE });
      return;
    }
    void retry();
  }, [markerSignature, sessionId, setGate]);

  return {
    gate,
    // Fail closed on the very first render; the session-owned gate atom begins
    // idle and is only advanced by an effect, but a durable marker already in
    // the loaded session must never expose one interactive frame.
    blocked: rawMarker !== null || gate.status !== "idle",
    retry,
    requireRecovery,
  };
}
