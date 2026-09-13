import { useEffect, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  selectedMachineAtom,
  machineSessionSelectionsAtom,
} from "../store/atoms/remoteMachines";
import {
  selectedWorkstreamAtom,
  setSelectedWorkstreamAtom,
} from "../store/atoms/sessions";
import type { DeviceInfo } from "@nimbalyst/runtime/sync/types";

export function RemoteMachineSelector({
  workspacePath,
}: {
  workspacePath: string;
}) {
  const [host, setHost] = useAtom(selectedMachineAtom(workspacePath));
  const [selections, setSelections] = useAtom(
    machineSessionSelectionsAtom(workspacePath)
  );
  const currentSelection = useAtomValue(selectedWorkstreamAtom(workspacePath));
  const select = useSetAtom(setSelectedWorkstreamAtom);
  const [hosts, setHosts] = useState<DeviceInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.electronAPI
        .invoke("ai:remoteHosts", workspacePath)
        .then((value) => {
          if (!cancelled) setHosts(value);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspacePath]);
  if (!hosts.length && !host) return null;
  return (
    <select
      className="remote-machine-selector mt-1.5 w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-1 text-[12px] text-[var(--nim-text)]"
      aria-label="Execution machine"
      value={host}
      onChange={(event) => {
        const next = event.target.value;
        if (currentSelection)
          setSelections((previous) => ({
            ...previous,
            [host]: currentSelection.id,
          }));
        setHost(next);
        select({
          workspacePath,
          selection: selections[next]
            ? { type: "session", id: selections[next] }
            : null,
        });
      }}
    >
      <option value="">This Mac</option>
      {hosts.map((device) => (
        <option key={device.deviceId} value={device.deviceId}>
          {device.name}
          {device.isOnline === false ? " · Offline" : ""}
        </option>
      ))}
      {host && !hosts.some((device) => device.deviceId === host) && (
        <option value={host}>Remote machine · Offline</option>
      )}
    </select>
  );
}
