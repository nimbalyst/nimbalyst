import { randomUUID } from "node:crypto";
import type { MobileLiveScope, MobileLiveResult } from "./mobileLiveRelay";

export interface VoicePromptLease {
  token: string;
  version: string;
  binding: string;
  expiresAt: number;
  presented: boolean;
  actionId?: string;
  result?: MobileLiveResult;
}

export function voicePromptBinding(scope: MobileLiveScope): string {
  return JSON.stringify([
    scope.hostDeviceId,
    scope.projectId,
    scope.sessionId,
    scope.voiceGeneration,
    scope.announcingDeviceId,
  ]);
}

function sameDeviceSource(a: string, b: string): boolean {
  try {
    const left = JSON.parse(a),
      right = JSON.parse(b);
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === 5 &&
      right.length === 5 &&
      [0, 1, 2, 4].every((i) => left[i] === right[i])
    );
  } catch {
    return false;
  }
}

/** Durable reservation precedes the side effect. Unknown outcomes are never replayed. */
export class VoicePromptGate {
  constructor(
    private read: (key: string) => VoicePromptLease | undefined,
    private write: (key: string, value: VoicePromptLease) => void,
    private now = Date.now
  ) {}
  prepare(key: string, binding: string, version: string): VoicePromptLease {
    const old = this.read(key);
    if (old?.actionId)
      throw new Error(
        "This prompt answer was already dispatched. Inspect its existing result."
      );
    if (
      old &&
      old.expiresAt > this.now() &&
      old.binding !== binding &&
      !sameDeviceSource(old.binding, binding)
    )
      throw new Error("Another voice conversation owns this question.");
    const same =
      old &&
      old.binding === binding &&
      old.version === version &&
      old.expiresAt > this.now();
    const lease: VoicePromptLease = {
      token: same ? old.token : randomUUID(),
      binding,
      version,
      expiresAt: this.now() + 120000,
      presented: same ? old.presented : false,
    };
    this.write(key, lease);
    return lease;
  }
  validate(
    key: string,
    binding: string,
    version: string,
    token: string
  ): VoicePromptLease {
    const lease = this.read(key);
    if (
      !lease ||
      lease.binding !== binding ||
      lease.version !== version ||
      lease.token !== token ||
      lease.expiresAt <= this.now()
    )
      throw new Error(
        "The question changed or its presentation expired. Read it again."
      );
    return lease;
  }
  presented(
    key: string,
    binding: string,
    version: string,
    token: string
  ): void {
    const lease = this.validate(key, binding, version, token);
    if (lease.actionId) throw new Error("This question was already answered.");
    this.write(key, { ...lease, presented: true });
  }
  status(key: string, binding: string, token: string): MobileLiveResult {
    const lease = this.read(key);
    if (!lease || lease.binding !== binding || lease.token !== token)
      return { success: false, error: "No matching answer receipt." };
    return (
      lease.result ?? {
        success: false,
        result: JSON.stringify({
          status: lease.actionId ? "pending_or_unknown" : "not_dispatched",
        }),
        error: lease.actionId
          ? "Answer delivery is pending or unknown. Do not replay it."
          : "No answer has been dispatched.",
      }
    );
  }
  async answer(
    key: string,
    binding: string,
    version: string,
    token: string,
    actionId: string,
    execute: () => Promise<MobileLiveResult>
  ): Promise<MobileLiveResult> {
    const lease = this.validate(key, binding, version, token);
    if (!lease.presented)
      throw new Error("This question has not finished playing.");
    if (lease.actionId) return this.status(key, binding, token);
    this.write(key, { ...lease, actionId });
    let result: MobileLiveResult;
    try {
      result = await execute();
    } catch {
      result = {
        success: false,
        error:
          "Answer delivery failed or is unknown. Inspect the app card before doing anything else.",
      };
    }
    this.write(key, { ...lease, actionId, result });
    return result;
  }
}
