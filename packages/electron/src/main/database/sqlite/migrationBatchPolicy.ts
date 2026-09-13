const TARGET_READ_MS = 2_000;
const TARGET_BYTES = 4 * 1024 * 1024;
export const MIGRATION_RECOVERY_BUDGET_MS = 180_000;

/** Approximate retained payload without allocating a second serialized copy. */
export function estimatePayloadBytes(value: unknown): number {
  if (value == null) return 4;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value !== "object") return 8;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (value instanceof Date) return 8;
  if (Array.isArray(value))
    return value.reduce<number>(
      (sum, item) => sum + estimatePayloadBytes(item),
      0
    );
  let bytes = 0;
  for (const [key, item] of Object.entries(value))
    bytes += Buffer.byteLength(key, "utf8") + estimatePayloadBytes(item);
  return bytes;
}

export class MigrationBatchPolicy {
  limit: number;
  private comfortable = 0;

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new Error("Migration batch size must be a positive integer");
    this.limit = Math.min(500, maximum);
  }

  timedOut(): void {
    this.comfortable = 0;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
  }

  succeeded(elapsedMs: number, bytes: number): void {
    const ratio = Math.min(
      TARGET_READ_MS / Math.max(1, elapsedMs),
      TARGET_BYTES / Math.max(1, bytes)
    );
    if (ratio < 1) {
      this.limit = Math.max(1, Math.floor(this.limit * ratio));
      this.comfortable = 0;
    } else if (ratio >= 2) {
      if (++this.comfortable >= 3) {
        this.limit = Math.min(
          this.maximum,
          this.limit + Math.max(1, Math.floor(this.limit / 4))
        );
        this.comfortable = 0;
      }
    } else {
      this.comfortable = 0;
    }
  }
}
