import type {
  DocumentFeedbackIndexSnapshot,
  DocumentFeedbackIndexSnapshotMessage,
} from "@nimbalyst/collab-protocol";

export interface DocumentFeedbackIndexClientState
  extends Omit<DocumentFeedbackIndexSnapshot, "status"> {
  status:
    | DocumentFeedbackIndexSnapshot["status"]
    | "connecting"
    | "disconnected"
    | "unsupported";
  epoch: string;
  sequence: number;
}

/** Connection lifetime and capability detection for the additive inventory lane. */
export class DocumentFeedbackIndexClient {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private epoch = crypto.randomUUID();
  private sequence = 0;
  private generation = -1;
  private active = false;
  constructor(
    private changed: (state: DocumentFeedbackIndexClientState) => void
  ) {}
  start(send: () => void): void {
    this.clearTimer();
    this.active = true;
    this.epoch = crypto.randomUUID();
    this.generation = -1;
    this.emit({ status: "connecting", entries: [], generation: -1 });
    this.timer = setTimeout(
      () => this.emit({ status: "unsupported", entries: [], generation: -1 }),
      10_000
    );
    send();
  }
  receive(message: DocumentFeedbackIndexSnapshotMessage): void {
    if (!this.active || message.generation < this.generation) return;
    this.clearTimer();
    this.generation = message.generation;
    this.emit(message);
  }
  disconnect(): void {
    this.clearTimer();
    this.active = false;
    this.emit({ status: "disconnected", entries: [], generation: -1 });
  }
  private emit(
    state: Omit<DocumentFeedbackIndexClientState, "epoch" | "sequence">
  ): void {
    this.changed({ ...state, epoch: this.epoch, sequence: ++this.sequence });
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
