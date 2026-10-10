/**
 * Records the revisions a shared page's history is made of. The server never
 * takes a snapshot on its own; an open editor posts them:
 *
 *   - `bootstrap` once, when the room has no revisions yet;
 *   - `auto` after the content has been idle for a while and is not already
 *     the latest recorded revision.
 *
 * Only while the page is connected and writable. Shared by the desktop's page
 * bodies that are not a collaborative tab (a typed page's body, a type page's
 * prose) and every page the web console mounts; the desktop's collaborative
 * tab runs the same loop in `CollaborativeTabEditor`. Two clients recording
 * the same content inside the server's dedupe window collapse into one
 * revision.
 */
import type { CollabHistoryController } from './collabHistoryController';

export const AUTO_REVISION_POLL_MS = 30_000;
export const AUTO_REVISION_IDLE_MS = 60_000;
export const AUTO_REVISION_MIN_INTERVAL_MS = 5 * 60 * 1000;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class CollabRevisionRecorder {
  private bootstrapEnsured = false;
  private running = false;
  private lastObservedHash: string | null = null;
  private lastObservedAt = 0;
  private lastRecordedHash: string | null = null;
  private lastAutoAt = 0;

  constructor(
    private readonly controller: CollabHistoryController,
    private readonly now: () => number = Date.now,
  ) {}

  /** One pass: bootstrap the history if needed, else record an idle change. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    const { controller } = this;
    if (!controller.exportSnapshot || controller.isReadOnly?.()) return;
    if (controller.getStatus() !== 'connected') return;
    this.running = true;
    try {
      if (!this.bootstrapEnsured) {
        await this.ensureBootstrap();
        return;
      }
      const snapshot = await this.snapshot();
      // The revisions endpoint rejects an empty payload; a body that never
      // hydrated must not retry a doomed POST every poll.
      if (!snapshot) return;
      const hash = await sha256Hex(snapshot);
      const now = this.now();
      if (hash !== this.lastObservedHash) {
        this.lastObservedHash = hash;
        this.lastObservedAt = now;
        return;
      }
      if (now - this.lastObservedAt < AUTO_REVISION_IDLE_MS) return;
      if (now - this.lastAutoAt < AUTO_REVISION_MIN_INTERVAL_MS) return;
      if (hash === this.lastRecordedHash) return;
      await this.create('auto', snapshot);
      this.lastRecordedHash = hash;
      this.lastAutoAt = now;
    } catch (error) {
      console.warn('[CollabRevisionRecorder] Could not record a page revision', error);
    } finally {
      this.running = false;
    }
  }

  private async ensureBootstrap(): Promise<void> {
    const latest = (await this.controller.client.listRevisions({ limit: 1 })).revisions[0] ?? null;
    if (latest) {
      this.lastRecordedHash = latest.contentHash;
      this.lastObservedHash = latest.contentHash;
      this.lastObservedAt = this.now();
      if (latest.revisionKind === 'auto') this.lastAutoAt = latest.createdAt;
      this.bootstrapEnsured = true;
      return;
    }
    const snapshot = await this.snapshot();
    if (!snapshot) return;
    await this.create('bootstrap', snapshot);
    const hash = await sha256Hex(snapshot);
    this.lastRecordedHash = hash;
    this.lastObservedHash = hash;
    this.lastObservedAt = this.now();
    this.bootstrapEnsured = true;
  }

  private async snapshot(): Promise<Uint8Array | null> {
    const raw = await this.controller.exportSnapshot!();
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return bytes.byteLength > 0 ? bytes : null;
  }

  private async create(revisionKind: 'bootstrap' | 'auto', plaintext: Uint8Array): Promise<void> {
    await this.controller.client.createRevision({
      revisionKind,
      editorType: this.controller.editorType,
      contentFormat: this.controller.contentFormat,
      plaintext,
      basisSequence: this.controller.getBasisSequence(),
    });
  }
}

/**
 * Record a mounted page's revisions until the returned stop is called: one
 * pass now, then one every {@link AUTO_REVISION_POLL_MS}.
 */
export function startCollabRevisionRecording(
  controller: CollabHistoryController,
  options: { now?: () => number; pollMs?: number } = {},
): () => void {
  const recorder = new CollabRevisionRecorder(controller, options.now);
  void recorder.tick();
  const intervalId = setInterval(() => { void recorder.tick(); }, options.pollMs ?? AUTO_REVISION_POLL_MS);
  return () => clearInterval(intervalId);
}
