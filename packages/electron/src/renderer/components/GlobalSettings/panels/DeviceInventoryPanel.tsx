import { useEffect, useRef, useState } from "react";
import type {
  PersonalSyncDevice,
  PersonalSyncDevicesResult,
  DeviceInventoryUpdate,
} from "../../../../main/services/PersonalSyncDevicesService";

function lastSeen(device: PersonalSyncDevice): string {
  const time = device.lastSeenAt ?? device.lastActiveAt ?? device.connectedAt;
  return time ? new Date(time).toLocaleString() : "Unknown";
}

export function DeviceInventoryPanel({ enabled }: { enabled: boolean }) {
  const [result, setResult] = useState<PersonalSyncDevicesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const generation = useRef(0);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const load = async (update?: Omit<DeviceInventoryUpdate, "accountId">) => {
    const request = ++generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = (await window.electronAPI.invoke(
        update ? "sync:update-devices" : "sync:get-devices",
        ...(update
          ? [
              {
                ...update,
                accountId: result?.success ? result.accountId : null,
              },
            ]
          : [])
      )) as PersonalSyncDevicesResult;
      if (!mounted.current || request !== generation.current) return;
      if (!next.success) setError(next.error);
      else {
        setResult(next);
        if (update) setSelected(new Set());
      }
    } catch (cause) {
      if (mounted.current && request === generation.current)
        setError(
          cause instanceof Error ? cause.message : "Could not update devices"
        );
    } finally {
      if (mounted.current && request === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (enabled) void load();
    else {
      setResult(null);
      setSelected(new Set());
    }
    const timer = enabled
      ? setInterval(() => {
          if (!busyRef.current) void load();
        }, 30000)
      : undefined;
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [enabled]);
  const devices = enabled && result?.success ? result.devices : [];
  const canEdit =
    enabled && result?.success && (result.inventoryVersion ?? 0) >= 1;
  const hideIds = devices
    .filter(
      (d) => selected.has(d.deviceId) && !d.isOnline && !d.inventoryHidden
    )
    .map((d) => d.deviceId);
  return (
    <section className="device-inventory-panel provider-panel-section py-4">
      <div className="flex items-center gap-2 mb-3">
        <h4 className="text-[15px] font-semibold text-nim">Paired devices</h4>
        <button
          className="px-2 py-1 border border-nim rounded text-nim-muted"
          disabled={busy || !enabled}
          onClick={() => void load()}
        >
          Refresh
        </button>
        {canEdit && (
          <button
            className="px-2 py-1 border border-nim rounded text-nim-muted"
            disabled={busy || !hideIds.length}
            onClick={() => void load({ deviceIds: hideIds, hidden: true })}
          >
            Hide selected
          </button>
        )}
      </div>
      <p className="text-[12px] text-nim-muted mb-3">
        Offline computers without history in this project leave the execution
        picker automatically. Hiding a computer keeps its sessions and
        credentials. Older sessions stay associated with that computer; hiding
        it does not move sessions or repair sync keys. It reappears if it reconnects.
        Restoring app data from a backup or moving it to another volume registers
        a new computer.
      </p>
      {error && (
        <p role="alert" className="text-nim-error text-[12px] select-text">
          {error}
        </p>
      )}
      {!enabled && (
        <p className="text-nim-muted text-[12px]">
          Enable personal sync to view paired devices.
        </p>
      )}
      {enabled && !busy && !devices.length && (
        <p className="text-nim-muted text-[12px]">No paired devices.</p>
      )}
      {enabled && result?.success && !canEdit && (
        <p className="text-nim-muted text-[12px]">
          Inventory changes require an updated sync server.
        </p>
      )}
      {devices.map((device) => (
        <DeviceRow
          key={`${device.deviceId}:${device.name}`}
          device={device}
          busy={busy}
          canEdit={!!canEdit}
          selected={selected.has(device.deviceId)}
          onSelect={(checked) =>
            setSelected((previous) => {
              const next = new Set(previous);
              if (checked) next.add(device.deviceId);
              else next.delete(device.deviceId);
              return next;
            })
          }
          onUpdate={(update) =>
            void load({ deviceIds: [device.deviceId], ...update })
          }
        />
      ))}
    </section>
  );
}

function DeviceRow({
  device,
  busy,
  canEdit,
  selected,
  onSelect,
  onUpdate,
}: {
  device: PersonalSyncDevice;
  busy: boolean;
  canEdit: boolean;
  selected: boolean;
  onSelect(checked: boolean): void;
  onUpdate(
    update: Omit<DeviceInventoryUpdate, "deviceIds" | "accountId">
  ): void;
}) {
  const [name, setName] = useState(device.name);
  return (
    <div className="device-inventory-row flex items-center gap-2 px-2.5 py-2 bg-nim-secondary rounded mb-1.5">
      {canEdit && (
        <input
          type="checkbox"
          aria-label={`Select ${device.name}`}
          checked={selected}
          disabled={busy || !!device.isOnline || !!device.inventoryHidden}
          onChange={(e) => onSelect(e.target.checked)}
        />
      )}
      <div className="flex-1 min-w-0">
        <input
          aria-label={`Name for ${device.name}`}
          className="w-full bg-transparent text-nim text-[13px]"
          value={name}
          maxLength={80}
          disabled={busy || !canEdit}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="text-[11px] text-nim-faint">
          {device.isOnline
            ? "Online"
            : device.inventoryHidden
            ? "Hidden · Offline"
            : "Offline"}{" "}
          · {device.platform} · {device.deviceId.slice(-6)}
          {!device.isOnline && ` · Last seen ${lastSeen(device)}`}
        </div>
      </div>
      {canEdit && name.trim() !== device.name && (
        <button
          className="text-[12px] text-nim-link"
          disabled={busy || !name.trim()}
          onClick={() => onUpdate({ label: name.trim() })}
        >
          Save name
        </button>
      )}
      {canEdit && !device.isOnline && (
        <button
          className="text-[12px] text-nim-link"
          disabled={busy}
          onClick={() => onUpdate({ hidden: !device.inventoryHidden })}
        >
          {device.inventoryHidden ? "Restore" : "Hide"}
        </button>
      )}
    </div>
  );
}
