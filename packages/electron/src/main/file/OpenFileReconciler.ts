import { stat } from "fs/promises";
import type { Stats } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import { pathExistsAfterRename } from "./pathExistsAfterRename";

export type ReconciliationResult =
  | { status: "changed" | "deleted" }
  | { status: "error"; errorCode: string };
interface Registration {
  owner: string;
  token: string;
  notify: (result: ReconciliationResult) => void;
}
interface OpenFile {
  path: string;
  registrations: Map<string, Registration>;
  signature?: string;
  lastForcedAt: number;
  running: boolean;
}

/** A single bounded queue for open paths, independent of native workspace watchers (#1499). */
export class OpenFileReconciler {
  private files = new Map<string, OpenFile>();
  private registrations = new Map<string, OpenFile>();
  private queued = new Map<OpenFile, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pass: Promise<void> | null = null;
  private stats = {
    probes: 0,
    failures: 0,
    notifications: 0,
    lastCompletedAt: 0,
  };

  constructor(
    private readonly readStat: (
      file: string
    ) => Promise<
      Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">
    > = stat,
    private readonly existsAfterRename = pathExistsAfterRename
  ) {}

  register(
    owner: string,
    token: string,
    path: string,
    notify: Registration["notify"]
  ): void {
    if (
      !owner ||
      !token ||
      token.length > 200 ||
      !isAbsolute(path) ||
      path.includes("\0")
    )
      throw new Error("Invalid open-file registration");
    path = resolve(path);
    const key = JSON.stringify([owner, token]);
    const registered = this.registrations.get(key);
    if (registered && registered.path !== path)
      throw new Error("Open-file token already belongs to another path");
    let file = this.files.get(path);
    if (!file) {
      file = {
        path,
        registrations: new Map(),
        lastForcedAt: 0,
        running: false,
      };
      this.files.set(path, file);
    }
    file.registrations.set(key, { owner, token, notify });
    this.registrations.set(key, file);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.reconcile();
      }, 5000);
      this.timer.unref?.();
    }
    void this.enqueue([file], true);
  }

  unregister(owner: string, token: string): void {
    const key = JSON.stringify([owner, token]);
    const file = this.registrations.get(key);
    if (!file) return;
    this.registrations.delete(key);
    file.registrations.delete(key);
    if (!file.registrations.size) {
      this.files.delete(file.path);
      this.queued.delete(file);
    }
    if (!this.files.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  releaseOwner(owner: string): void {
    for (const file of this.files.values()) {
      for (const registration of [...file.registrations.values()]) {
        if (registration.owner === owner)
          this.unregister(owner, registration.token);
      }
    }
  }

  reconcile(force = false, owner?: string): Promise<void> {
    return this.enqueue(
      [...this.files.values()].filter(
        (file) =>
          !owner ||
          [...file.registrations.values()].some((reg) => reg.owner === owner)
      ),
      force
    );
  }

  reconcileRoot(root: string): Promise<void> {
    return this.enqueue(
      [...this.files.values()].filter((file) => {
        const rel = relative(root, file.path);
        return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      }),
      true
    );
  }

  getStats() {
    return {
      ...this.stats,
      registeredPaths: this.files.size,
      registrations: this.registrations.size,
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.files.clear();
    this.registrations.clear();
    this.queued.clear();
  }

  private enqueue(files: OpenFile[], force: boolean): Promise<void> {
    for (const file of files)
      this.queued.set(file, force || this.queued.get(file) === true);
    if (this.pass) return this.pass;
    if (!this.queued.size) return Promise.resolve();
    this.pass = Promise.resolve()
      .then(async () => {
        const worker = async () => {
          while (true) {
            const next = [...this.queued].find(([file]) => !file.running);
            if (!next) return;
            const [file, forceRead] = next;
            this.queued.delete(file);
            file.running = true;
            try {
              await this.probe(file, forceRead);
            } finally {
              file.running = false;
            }
          }
        };
        await Promise.all(Array.from({ length: 4 }, worker));
        this.stats.lastCompletedAt = Date.now();
      })
      .finally(() => {
        this.pass = null;
        if (this.queued.size) void this.enqueue([], false);
      });
    return this.pass;
  }

  private async probe(file: OpenFile, forced: boolean): Promise<void> {
    const current = () => this.files.get(file.path) === file;
    if (!current()) return;
    this.stats.probes++;
    let signature: string;
    try {
      let metadata;
      try {
        metadata = await this.readStat(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (await this.existsAfterRename(file.path))
          metadata = await this.readStat(file.path);
      }
      signature = metadata
        ? [
            metadata.dev,
            metadata.ino,
            metadata.size,
            metadata.mtimeMs,
            metadata.ctimeMs,
          ].join(":")
        : "deleted";
    } catch (error) {
      if (current()) {
        this.stats.failures++;
        this.notify(file, {
          status: "error",
          errorCode: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
        });
      }
      return;
    }
    if (!current()) return;
    // Periodic forced reads catch preserved timestamps and silent native stalls.
    const forceRead = forced || Date.now() - file.lastForcedAt >= 60_000;
    if (forceRead || signature !== file.signature) {
      this.notify(file, {
        status: signature === "deleted" ? "deleted" : "changed",
      });
      file.signature = signature;
      if (forceRead) file.lastForcedAt = Date.now();
    }
  }

  private notify(file: OpenFile, result: ReconciliationResult): void {
    for (const registration of file.registrations.values()) {
      try {
        registration.notify(result);
        this.stats.notifications++;
      } catch {
        this.unregister(registration.owner, registration.token);
      }
    }
  }
}

export const openFileReconciler = new OpenFileReconciler();
