export interface FileWatchHealth {
  state: "starting" | "watching" | "recovering" | "stopped";
  generation: number;
  reason?: string;
  nextRetryAt?: number;
}
