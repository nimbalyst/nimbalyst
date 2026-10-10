/**
 * The wiki's change notifications as a Server-Sent Events stream. One
 * `wiki.watch` subscription feeds every open tab; each event is the library's
 * `LocalWikiChange`, which covers edits made by this server, by `nim`, by the
 * desktop app, and by hand.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocalWiki, LocalWikiChange } from '@nimbalyst/local-wiki';

const HEARTBEAT_MS = 25_000;

export class ChangeStream {
  private readonly clients = new Set<ServerResponse>();
  private unwatch: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(private readonly wiki: LocalWiki) {}

  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // The first frame tells the client the stream is live, so it can refetch
    // anything it may have missed while disconnected.
    res.write(`retry: 2000\nevent: ready\ndata: {"seq":${this.seq}}\n\n`);
    this.clients.add(res);
    this.start();
    req.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stop();
    });
  }

  private start(): void {
    if (this.unwatch) return;
    this.unwatch = this.wiki.watch((change) => this.broadcast(change));
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(': keepalive\n\n');
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private broadcast(change: LocalWikiChange): void {
    this.seq += 1;
    const frame = `id: ${this.seq}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  close(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.stop();
  }
}
