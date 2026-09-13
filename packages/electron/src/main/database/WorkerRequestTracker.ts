import { randomUUID } from "node:crypto";
import {
  type SerializedWorkerError,
  deserializeWorkerError,
} from "./workerErrorSerialization";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns request lifetime, including requests whose callers stopped waiting. */
export class WorkerRequestTracker {
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly post: (message: unknown) => void) {}

  send(
    type: string,
    payload?: unknown,
    timeoutMs: number | null = 30_000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const pending: PendingRequest = { resolve, reject };
      this.pending.set(id, pending);
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Request ${type} timed out`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      try {
        this.post({ id, type, payload });
      } catch (error) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  receive(response: {
    id: string;
    success: boolean;
    data?: unknown;
    errorData?: SerializedWorkerError;
    error?: string;
  }): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.success) pending.resolve(response.data);
    else
      pending.reject(
        deserializeWorkerError(response.errorData, response.error)
      );
    return true;
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
