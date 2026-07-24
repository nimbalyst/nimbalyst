/**
 * Permission Usage Tracker
 *
 * Small in-memory ring buffer of permission-gated call events. Powers the
 * "Privileged Extensions" global view timeline (Phase 4) without persisting
 * anything to disk - usage telemetry resets on app restart by design (this is
 * a runtime diagnostic, not an audit log).
 *
 * The ring is capped per (extension, module, permission) tuple so a chatty
 * module can't crowd out a quiet one. A single global cap on entry count would
 * let a high-volume permission starve all other rows from view.
 */

import type { ExtensionPermissionId } from '@nimbalyst/extension-sdk';

const PER_TUPLE_RING_SIZE = 50;
const MAX_TUPLES_TRACKED = 256;

export interface UsageEvent {
  extensionId: string;
  moduleId: string;
  permissionId: ExtensionPermissionId;
  /** epoch ms */
  timestamp: number;
  /** Optional outcome - "allowed" vs "denied" so the timeline can mark refusals */
  outcome: 'allowed' | 'denied';
  /** RPC method that triggered the check, for debugging */
  method?: string;
}

export interface UsageSummary {
  extensionId: string;
  moduleId: string;
  permissionId: ExtensionPermissionId;
  total: number;
  allowed: number;
  denied: number;
  /** epoch ms of the most recent event */
  lastAt?: number;
}

function keyOf(
  extensionId: string,
  moduleId: string,
  permissionId: ExtensionPermissionId
): string {
  return `${extensionId}::${moduleId}::${permissionId}`;
}

class PermissionUsageTracker {
  private rings = new Map<string, UsageEvent[]>();

  record(event: Omit<UsageEvent, 'timestamp'> & { timestamp?: number }): void {
    const entry: UsageEvent = {
      extensionId: event.extensionId,
      moduleId: event.moduleId,
      permissionId: event.permissionId,
      timestamp: event.timestamp ?? Date.now(),
      outcome: event.outcome,
      method: event.method,
    };
    const key = keyOf(entry.extensionId, entry.moduleId, entry.permissionId);
    let ring = this.rings.get(key);
    if (!ring) {
      if (this.rings.size >= MAX_TUPLES_TRACKED) {
        // Evict the oldest-touched tuple. Cheap and deterministic - we don't
        // need LRU precision here; the cap is a safety net.
        const firstKey = this.rings.keys().next().value;
        if (firstKey !== undefined) {
          this.rings.delete(firstKey);
        }
      }
      ring = [];
      this.rings.set(key, ring);
    }
    ring.push(entry);
    if (ring.length > PER_TUPLE_RING_SIZE) {
      ring.splice(0, ring.length - PER_TUPLE_RING_SIZE);
    }
  }

  /** All events for one (extension, module), newest last. */
  listForModule(extensionId: string, moduleId: string): UsageEvent[] {
    const out: UsageEvent[] = [];
    for (const [key, ring] of this.rings) {
      if (key.startsWith(`${extensionId}::${moduleId}::`)) {
        out.push(...ring);
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /** All events across all modules, newest last. */
  listAll(): UsageEvent[] {
    const out: UsageEvent[] = [];
    for (const ring of this.rings.values()) {
      out.push(...ring);
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /** Aggregated counts per tuple. Stable order: extension, module, permission. */
  summarize(): UsageSummary[] {
    const out: UsageSummary[] = [];
    for (const ring of this.rings.values()) {
      if (ring.length === 0) continue;
      const first = ring[0];
      let allowed = 0;
      let denied = 0;
      let lastAt = 0;
      for (const e of ring) {
        if (e.outcome === 'allowed') allowed += 1;
        else denied += 1;
        if (e.timestamp > lastAt) lastAt = e.timestamp;
      }
      out.push({
        extensionId: first.extensionId,
        moduleId: first.moduleId,
        permissionId: first.permissionId,
        total: ring.length,
        allowed,
        denied,
        lastAt,
      });
    }
    out.sort((a, b) => {
      if (a.extensionId !== b.extensionId) return a.extensionId.localeCompare(b.extensionId);
      if (a.moduleId !== b.moduleId) return a.moduleId.localeCompare(b.moduleId);
      return a.permissionId.localeCompare(b.permissionId);
    });
    return out;
  }

  /** Drop everything for one extension (called on uninstall / revoke-all). */
  clearExtension(extensionId: string): void {
    for (const key of [...this.rings.keys()]) {
      if (key.startsWith(`${extensionId}::`)) {
        this.rings.delete(key);
      }
    }
  }

  /** Drop everything. Test helper. */
  clearAll(): void {
    this.rings.clear();
  }
}

const tracker = new PermissionUsageTracker();

export function getPermissionUsageTracker(): PermissionUsageTracker {
  return tracker;
}

export { PermissionUsageTracker };
