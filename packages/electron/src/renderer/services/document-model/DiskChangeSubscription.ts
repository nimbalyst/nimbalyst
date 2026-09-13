import { store } from "@nimbalyst/runtime/store";
import {
  fileChangedOnDiskAtomFamily,
  fileDeletedAtomFamily,
  historyPendingTagCreatedAtomFamily,
  fileReconciliationAtomFamily,
  activeFileReconciliations,
} from "../../store/atoms/fileWatch";
import { errorNotificationService } from "../ErrorNotificationService";
import type { ExternalChangeInfo } from "./types";

/** Coalesces disk reads and owns the sender-scoped open-file registration for one backing store. */
export class DiskChangeSubscription {
  private token = crypto.randomUUID();
  private disposed = false;
  private missing = false;
  private sequence = 0;
  private pendingTags = false;
  private reading = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private warningShown = false;
  private registrationRetry: ReturnType<typeof setTimeout> | null = null;
  private registrationFailures = 0;
  private cleanups: Array<() => void> = [];

  constructor(
    private path: string,
    private load: () => Promise<string | ArrayBuffer>,
    private changed: (info: ExternalChangeInfo) => void,
    private deleted: () => void
  ) {
    const changes = fileChangedOnDiskAtomFamily(path);
    const tags = historyPendingTagCreatedAtomFamily(path);
    const deletes = fileDeletedAtomFamily(path);
    const reconciliation = fileReconciliationAtomFamily(this.token);
    activeFileReconciliations.add(this.token);
    this.cleanups.push(
      store.sub(changes, () => this.signal(false)),
      store.sub(tags, () => this.signal(true)),
      store.sub(deletes, () => this.signalDeleted()),
      store.sub(reconciliation, () => {
        const result = store.get(reconciliation);
        if (result?.status === "deleted")
          store.set(deletes, (value) => value + 1);
        else if (result?.status === "error") this.readFailed(result.errorCode);
        else if (result?.status === "changed") this.signal(false);
      })
    );
    // Subscription is installed synchronously before main can send the initial check.
    void this.register();
  }

  private async register(): Promise<void> {
    if (typeof window === "undefined" || !window.electronAPI?.invoke) return;
    try {
      await window.electronAPI.invoke(
        "file:register-open",
        this.token,
        this.path
      );
      if (this.disposed)
        await window.electronAPI.invoke("file:unregister-open", this.token);
    } catch (error) {
      if (!this.disposed) {
        console.error("[DiskChangeSubscription] Registration failed:", error);
        this.warn();
        const delay = [1000, 5000, 15_000, 60_000][
          Math.min(this.registrationFailures++, 3)
        ];
        this.registrationRetry = setTimeout(() => {
          this.registrationRetry = null;
          void this.register();
        }, delay);
      }
    }
  }

  private signal(tags: boolean): void {
    if (this.disposed) return;
    this.missing = false;
    this.sequence++;
    this.pendingTags ||= tags;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (!this.reading) void this.read();
  }

  private signalDeleted(): void {
    if (this.disposed) return;
    this.sequence++;
    this.missing = true;
    this.pendingTags = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.deleted();
  }

  private async read(): Promise<void> {
    if (this.disposed) return;
    this.reading = true;
    const sequence = this.sequence;
    const checkPendingTags = this.pendingTags;
    this.pendingTags = false;
    try {
      const content = await this.load();
      if (this.disposed) return;
      if (sequence !== this.sequence) {
        this.pendingTags ||= checkPendingTags;
        return;
      }
      this.failures = 0;
      this.warningShown = false;
      // Reads arrive in order here; DocumentModel assigns the shared ordering
      // sequence, including its own recovery reads.
      this.changed({
        content,
        timestamp: Date.now(),
        checkPendingTags,
      });
    } catch (error) {
      this.pendingTags ||= checkPendingTags;
      if (!this.disposed && sequence === this.sequence) this.readFailed(error);
    } finally {
      this.reading = false;
      if (!this.disposed && !this.missing && sequence !== this.sequence)
        void this.read();
    }
  }

  private readFailed(error: unknown): void {
    if (this.disposed || this.retry) return;
    const delay = [50, 250, 1000][this.failures++];
    if (delay === undefined) {
      console.error(
        "[DiskChangeSubscription] Disk reconciliation failed:",
        error
      );
      this.warn();
      return;
    }
    this.retry = setTimeout(() => {
      this.retry = null;
      this.signal(false);
    }, delay);
  }

  private warn(): void {
    if (this.warningShown) return;
    this.warningShown = true;
    errorNotificationService.showWarning(
      "File updates delayed",
      `Could not refresh ${this.path
        .split(/[\\/]/)
        .pop()}. Your unsaved edits are preserved.`,
      { duration: 10_000 }
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.registrationRetry) clearTimeout(this.registrationRetry);
    this.cleanups.forEach((cleanup) => cleanup());
    activeFileReconciliations.delete(this.token);
    fileReconciliationAtomFamily.remove(this.token);
    if (typeof window !== "undefined" && window.electronAPI?.invoke) {
      void window.electronAPI
        .invoke("file:unregister-open", this.token)
        .catch((error) =>
          console.error("[DiskChangeSubscription] Unregister failed:", error)
        );
    }
  }
}
