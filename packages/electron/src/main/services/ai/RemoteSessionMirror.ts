import { randomUUID } from 'node:crypto';
import { TranscriptRuntime } from '@nimbalyst/runtime/ai/server/transcript/TranscriptRuntime';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
import type { ChatAttachment, SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { DeviceInfo, SyncProvider } from '@nimbalyst/runtime/sync/types';

type IndexEntry = NonNullable<Awaited<ReturnType<NonNullable<SyncProvider['fetchIndex']>>>>['sessions'][number];
import type { RemoteSessionSnapshot } from '../../../shared/remoteSessions';
export type { RemoteSessionSnapshot } from '../../../shared/remoteSessions';
interface Observation {
  entry: IndexEntry;
  rows: Map<number, RawMessage>;
  bytes: number;
  listeners: Set<(snapshot: RemoteSessionSnapshot) => void>;
  runtime: TranscriptRuntime;
  dispose(): void;
  timer?: ReturnType<typeof setTimeout>;
  publishing?: Promise<void>;
  dirty: boolean;
  error?: string;
  rowVersion: number;
  projectedVersion: number;
}

/** Account-scoped, read-only mirrors. Nothing is inserted into the execution store. */
export class RemoteSessionMirror {
  private provider: SyncProvider | null = null;
  private encryptionKey: CryptoKey | null = null;
  private entries = new Map<string, IndexEntry>();
  private observations = new Map<string, Observation>();
  private unlistenIndex?: () => void;
  private unlistenDevices?: () => void;
  private refreshInFlight?: Promise<void>;
  private refreshedAt = 0;
  private queueWrites = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: {
    preparePrompt?(prompt: string, workspace: string): Promise<string>;
    encryptAttachments?(attachments: ChatAttachment[], workspace: string, key: CryptoKey): Promise<import("@nimbalyst/runtime/sync/types").EncryptedAttachment[]>;
    hasLocalSession(id: string): Promise<boolean>;
    listChanged(workspacePath: string, sessionId: string): void;
  }) {}

  setProvider(provider: SyncProvider | null, encryptionKey: CryptoKey | null = null): void {
    this.encryptionKey = encryptionKey;
    if (provider === this.provider) return;
    this.unlistenIndex?.();
    this.unlistenDevices?.();
    for (const [id, observation] of this.observations) {
      observation.dispose();
      this.provider?.disconnect(id);
      for (const listener of observation.listeners) listener({
        session: this.sessionData(observation.entry, []), connected: false,
        hostOnline: false, syncing: false, executing: false, queuedPrompts: [],
        error: 'Session sync changed. Reopen this remote session to reconnect.',
      });
    }
    for (const workspace of new Set([...this.entries.values()].map(entry => entry.projectId))) this.deps.listChanged(workspace, "");
    this.observations.clear(); this.entries.clear();
    this.refreshInFlight = undefined; this.refreshedAt = 0;
    this.provider = provider;
    this.unlistenIndex = provider?.onIndexChange?.((id) => {
      if (this.provider !== provider) return;
      const cached = provider.getCachedIndexEntry?.(id);
      if (!cached || !this.isRemoteHost(cached.hostDeviceId)) return;
      const entry = { ...this.entries.get(id), ...cached, sessionId: id } as IndexEntry;
      if (!entry.projectId) return;
      this.entries.set(id, entry);
      const observation = this.observations.get(id);
      if (observation) {
        const resumeTranscript = entry.isExecuting || (entry.messageCount ?? 0) > (observation.entry.messageCount ?? 0);
        observation.entry = entry;
        if (resumeTranscript && !provider.getStatus(id).connected) {
          void provider.connect(id).catch(() => { observation.error = 'The remote transcript could not reconnect. Reopen it to retry.'; this.schedule(id, observation); });
        }
        this.schedule(id, observation);
      }
      this.deps.listChanged(entry.projectId, id);
    });
    this.unlistenDevices = provider?.onDeviceStatusChange?.(() => {
      for (const [id, observation] of this.observations) this.schedule(id, observation);
    });
  }

  private isRemoteHost(host?: string): boolean {
    if (!host || host === this.provider?.getLocalDeviceInfo?.()?.deviceId) return false;
    const device = this.provider?.getConnectedDevices?.().find(device => device.deviceId === host);
    return host.startsWith('sandbox-') || device?.type === 'headless' || device?.type === 'desktop';
  }
  isRemote(sessionId: string): boolean {
    return this.isRemoteHost(this.provider?.getCachedIndexEntry?.(sessionId)?.hostDeviceId ?? this.entries.get(sessionId)?.hostDeviceId);
  }
  async assertLocalExecution(sessionId: string): Promise<void> {
    if (this.isRemote(sessionId) && !await this.deps.hasLocalSession(sessionId)) {
      throw new Error('Use the sandbox controls to send this prompt to its host.');
    }
  }
  private async refresh(): Promise<void> {
    if (!this.provider?.fetchIndex || Date.now() - this.refreshedAt < 5000) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    const provider = this.provider;
    const attempt = (async () => {
      const index = await provider.fetchIndex!();
      if (this.provider !== provider) return;
      const next = new Map(index.sessions.filter(entry => this.isRemoteHost(entry.hostDeviceId)).map(entry => [entry.sessionId, entry]));
      this.entries = next;
      this.refreshedAt = Date.now();
    })();
    this.refreshInFlight = attempt;
    try { await attempt; }
    finally { if (this.refreshInFlight === attempt) this.refreshInFlight = undefined; }
  }
  async list(workspacePath: string, local: SessionMeta[]): Promise<SessionMeta[]> {
    try { await this.refresh(); } catch { /* Local history remains usable offline. */ }
    const ids = new Set(local.map(entry => entry.id));
    const provider = this.provider;
    const remote: SessionMeta[] = [];
    const childCounts = new Map<string, number>();
    for (const child of this.entries.values()) {
      if (child.parentSessionId) childCounts.set(`${child.hostDeviceId}:${child.parentSessionId}`, (childCounts.get(`${child.hostDeviceId}:${child.parentSessionId}`) ?? 0) + 1);
    }
    for (const entry of this.entries.values()) {
      if (entry.projectId !== workspacePath || ids.has(entry.sessionId)) continue;
      if (await this.deps.hasLocalSession(entry.sessionId)) continue;
      if (this.provider !== provider) return local;
      remote.push({
        id: entry.sessionId, title: entry.title || 'Sandbox session', provider: entry.provider,
        model: entry.model, sessionType: entry.sessionType === 'workstream' ? 'workstream' : entry.sessionType === 'blitz' ? 'blitz' : 'session', mode: entry.mode ?? 'agent',
        workspaceId: workspacePath, worktreeId: null, parentSessionId: entry.parentSessionId ?? null,
        childCount: childCounts.get(`${entry.hostDeviceId}:${entry.sessionId}`) ?? 0, uncommittedCount: 0, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
        messageCount: entry.messageCount, isArchived: !!entry.isArchived, isPinned: !!entry.isPinned,
        remoteHostDeviceId: entry.hostDeviceId,
      });
    }
    return [...local, ...remote].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private async requireEntry(id: string, workspace: string): Promise<IndexEntry> {
    const provider = this.provider;
    await this.refresh();
    const entry = this.entries.get(id);
    if (!entry || !this.isRemoteHost(entry.hostDeviceId) || entry.projectId !== workspace || await this.deps.hasLocalSession(id)) {
      throw new Error('This remote session is not available in this workspace.');
    }
    if (provider !== this.provider) throw new Error('Session sync changed. Reopen this remote session.');
    return entry;
  }
  private sessionData(entry: IndexEntry, messages: SessionData['messages']): SessionData {
    return {
      id: entry.sessionId, title: entry.title || 'Sandbox session', provider: entry.provider,
      model: entry.model, sessionType: entry.sessionType === 'workstream' ? 'workstream' : entry.sessionType === 'blitz' ? 'blitz' : 'session', mode: entry.mode ?? 'agent',
      workspacePath: entry.projectId, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      messages, isArchived: entry.isArchived, isPinned: entry.isPinned,
      parentSessionId: entry.parentSessionId,
      metadata: { remoteHostDeviceId: entry.hostDeviceId },
    };
  }
  async get(id: string, workspace: string): Promise<SessionData | null> {
    if (await this.deps.hasLocalSession(id)) return null;
    try { await this.refresh(); } catch { return null; }
    if (!this.entries.has(id)) return null;
    const entry = await this.requireEntry(id, workspace);
    return this.sessionData(entry, []);
  }
  private hostOnline(entry: IndexEntry): boolean {
    if (this.provider?.isIndexReady?.() === false) return false;
    return this.provider?.getConnectedDevices?.().some(device => device.deviceId === entry.hostDeviceId && device.isOnline !== false) ?? false;
  }
  private readOnlyReason(entry: IndexEntry): string | undefined {
    const host = this.provider?.getConnectedDevices?.().find(device => device.deviceId === entry.hostDeviceId);
    // Headless connectedAt is fixed at process startup, including across token
    // refresh/socket reconnects. A new process cannot resume ephemeral sessions.
    if (host?.type === 'headless' && Number.isFinite(host.connectedAt) && host.connectedAt > entry.createdAt) {
      return 'The sandbox restarted after this session began. Its transcript is available, but start a new sandbox session to continue working.';
    }
    return undefined;
  }
  private async snapshot(id: string, observation: Observation): Promise<RemoteSessionSnapshot> {
    const status = this.provider?.getStatus(id);
    const version = observation.rowVersion;
    if (observation.projectedVersion !== version) {
      await observation.runtime.forceReparseSession(id, observation.entry.provider);
      observation.projectedVersion = version;
    }
    return {
      session: this.sessionData(observation.entry, await observation.runtime.getViewMessages(id, observation.entry.provider)),
      connected: status?.connected ?? false, hostOnline: this.hostOnline(observation.entry),
      syncing: status?.syncing ?? false, executing: observation.entry.isExecuting ?? false,
      readOnlyReason: this.readOnlyReason(observation.entry),
      queuedPrompts: observation.entry.queuedPrompts ?? [], error: observation.error ?? status?.error ?? undefined,
    };
  }
  private schedule(id: string, observation: Observation): void {
    observation.dirty = true;
    if (observation.timer || observation.publishing) return;
    observation.timer = setTimeout(() => {
      observation.timer = undefined;
      observation.dirty = false;
      observation.publishing = this.snapshot(id, observation).then(snapshot => {
        if (this.observations.get(id) !== observation) return;
        for (const listener of observation.listeners) listener(snapshot);
      }).catch(() => { observation.error = 'The remote transcript could not be read. Reopen it to retry.'; }).finally(() => {
        observation.publishing = undefined;
        if (observation.dirty && this.observations.get(id) === observation) this.schedule(id, observation);
      });
    }, 150);
  }
  async watch(id: string, workspace: string, listener: (snapshot: RemoteSessionSnapshot) => void): Promise<() => void> {
    const entry = await this.requireEntry(id, workspace);
    const provider = this.provider;
    if (!provider) throw new Error('Session sync is not connected.');
    let observation = this.observations.get(id);
    if (!observation) {
      if (this.observations.size >= 4) throw new Error('Close another remote transcript before opening this one.');
      const rows = new Map<number, RawMessage>();
      const runtime = new TranscriptRuntime({ getMessages: async (_id, afterId) => [...rows.values()]
        // A retained row can arrive after the answer it preceded. Wire receipt
        // order is not agent turn order; timestamp ties keep the room sequence.
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
        .map((row, index) => ({ ...row, id: index + 1 }))
        .filter(row => afterId === undefined || row.id > afterId)
      }, { cacheCap: 1 });
      observation = { entry, rows, runtime, bytes: 0, dirty: false, rowVersion: 0, projectedVersion: -1, listeners: new Set(), dispose() {} };
      this.observations.set(id, observation);
      const current = observation;
      const offChange = provider.onRemoteChange(id, change => {
        if (change.type !== 'message_added' || change.message.sessionId !== id) return;
        const message = change.message;
        if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id <= 0 || rows.has(message.id)) return;
        const bytes = Buffer.byteLength(message.content, 'utf8');
        if (current.bytes + bytes > 8 * 1024 * 1024 || rows.size >= 20000) {
          current.error = 'This remote transcript exceeds the desktop viewing limit.';
          offChange(); provider.disconnect(id); this.schedule(id, current); return;
        }
        current.bytes += bytes;
        rows.set(message.id, { ...message, id: message.id, createdAt: new Date(message.createdAt ?? 0) });
        current.rowVersion++;
        this.schedule(id, current);
      });
      const offStatus = provider.onStatusChange(id, () => this.schedule(id, current));
      current.dispose = () => { offChange(); offStatus(); if (current.timer) clearTimeout(current.timer); };
      void provider.connect(id).catch(() => {
        current.error = 'The sandbox transcript could not connect. Reopen it to retry.';
        this.schedule(id, current);
      });
    }
    observation.listeners.add(listener);
    this.schedule(id, observation);
    const current = observation;
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size || this.observations.get(id) !== current) return;
      current.dispose(); this.observations.delete(id); provider.disconnect(id);
    };
  }
  queue(id: string, workspace: string, prompt: string, attachments: ChatAttachment[] = [], options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions): Promise<{promptId: string}> {
    const provider = this.provider;
    const previous = this.queueWrites.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (provider !== this.provider) throw new Error('Session sync changed. Keep the draft and retry.');
      return this.queueNow(id, workspace, prompt, attachments, options);
    }).finally(() => {
      if (this.queueWrites.get(id) === next) this.queueWrites.delete(id);
    });
    this.queueWrites.set(id, next);
    return next;
  }
  private async queueNow(id: string, workspace: string, prompt: string, attachments: ChatAttachment[] = [], options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions): Promise<{ promptId: string }> {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw new Error('Enter a prompt of at most 100,000 characters.');
    const entry = await this.requireEntry(id, workspace);
    const provider = this.provider;
    if (!provider || !this.hostOnline(entry)) throw new Error('The sandbox is offline. Your prompt has not been sent.');
    const readOnlyReason = this.readOnlyReason(entry);
    if (readOnlyReason) throw new Error(readOnlyReason);
    if (attachments.length && (!this.encryptionKey || !this.deps.encryptAttachments)) throw new Error("Attachment encryption is not ready. Keep the draft and retry.");
    // Empty session rooms can expire while a draft is open. Queue delivery uses
    // the index connection; reattach the existing observer before starting work.
    if (this.observations.has(id) && !provider.getStatus(id).connected) await provider.connect(id);
    if (provider !== this.provider) throw new Error('Session sync changed. Keep the draft and retry.');
    const preparedPrompt = this.deps.preparePrompt ? await this.deps.preparePrompt(prompt, workspace) : prompt;
    const encrypted = attachments.length ? await this.deps.encryptAttachments!(attachments, workspace, this.encryptionKey!) : [];
    if (provider !== this.provider) throw new Error("Session sync changed. Keep the draft and retry.");
    const promptId = `remote-${randomUUID()}`;
    const cached = provider.getCachedIndexEntry?.(id);
    const queue = cached?.queuedPrompts ?? entry.queuedPrompts ?? [];
    const outcome = await provider.pushChange(id, { type: 'metadata_updated', metadata: {
      queuedPrompts: [...queue, { id: promptId, prompt: preparedPrompt.trim(), timestamp: Date.now(), ...(encrypted.length ? {attachments: encrypted} : {}), ...(options ? {options} : {}) }],
    } });
    if (outcome && !outcome.published) throw new Error('The prompt could not be sent. Keep it and retry when connected.');
    return { promptId };
  }
  async workspaceContext(id: string, workspace: string): Promise<unknown> {
    const entry = await this.requireEntry(id, workspace);
    const provider = this.provider;
    const key = this.encryptionKey;
    if (!key || !provider?.sendSessionControlMessage || !provider.onSessionControlMessage || !this.hostOnline(entry)) throw new Error('The remote workspace is unavailable.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('The remote machine did not return its file and command list.')); }, 15000);
      const off = provider.onSessionControlMessage!(message => {
        if (message.type !== 'workspace-context-response' || message.sessionId !== id || message.payload?.requestId !== requestId || message.sentByDeviceId !== entry.hostDeviceId) return;
        clearTimeout(timer); off();
        if (provider !== this.provider) return reject(new Error('Session sync changed.'));
        const payload = message.payload;
        if (typeof payload.encrypted !== 'string' || payload.encrypted.length > 1024 * 1024 || typeof payload.iv !== 'string') return reject(new Error('Invalid remote workspace response.'));
        void crypto.subtle.decrypt({name: 'AES-GCM', iv: Buffer.from(payload.iv, 'base64')}, key, Buffer.from(payload.encrypted, 'base64'))
          .then(data => { if (provider !== this.provider) throw new Error('Session sync changed.'); return JSON.parse(new TextDecoder().decode(data)); }).then(resolve, reject);
      });
      void provider.sendSessionControlMessage!({sessionId: id, type: 'workspace-context-request', targetDeviceId: entry.hostDeviceId, sentByDeviceId: provider.getLocalDeviceInfo?.()?.deviceId, sentBy: 'desktop', timestamp: Date.now(), payload: {requestId}}).catch(error => {clearTimeout(timer); off(); reject(error);});
    });
  }

  async hosts(workspace: string): Promise<Array<Pick<DeviceInfo, 'deviceId' | 'name' | 'type' | 'isOnline'>>> {
    try { await this.refresh(); } catch { /* Retain offline history. */ }
    const hosts = new Map((this.provider?.getConnectedDevices?.() ?? []).filter(device => this.isRemoteHost(device.deviceId)).map(device => [device.deviceId, device]));
    for (const entry of this.entries.values()) {
      if (entry.projectId !== workspace || !entry.hostDeviceId || hosts.has(entry.hostDeviceId)) continue;
      hosts.set(entry.hostDeviceId, {deviceId: entry.hostDeviceId, name: 'Remote machine', type: 'headless', isOnline: false, platform: 'unknown', connectedAt: 0, lastActiveAt: 0});
    }
    return [...hosts.values()];
  }

  async create(workspace: string, host: string, options: {prompt?: string; model?: string; parentSessionId?: string; worktree?: boolean} = {}): Promise<string> {
    const provider = this.provider;
    const device = provider?.getConnectedDevices?.().find(device => device.deviceId === host && device.isOnline !== false);
    if (!device || !this.isRemoteHost(host) || !provider?.sendCreateSessionRequest || !provider.onCreateSessionResponse) throw new Error('The selected machine is offline.');
    if (options.worktree) throw new Error('This remote host does not support creating worktrees yet.');
    if (options.parentSessionId && (await this.requireEntry(options.parentSessionId, workspace)).hostDeviceId !== host) throw new Error("The parent session belongs to another machine.");
    if (provider !== this.provider) throw new Error('Session sync changed.');
    const initialPrompt = options.prompt && this.deps.preparePrompt ? await this.deps.preparePrompt(options.prompt, workspace) : options.prompt;
    if (provider !== this.provider) throw new Error("Session sync changed.");
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('The remote machine did not answer. Check its status before retrying.')); }, 60000);
      const off = provider.onCreateSessionResponse!(response => {
        if (response.requestId !== requestId) return;
        clearTimeout(timer); off();
        if (provider !== this.provider) return reject(new Error('Session sync changed.'));
        if (response.success && response.sessionId) { this.refreshedAt = 0; resolve(response.sessionId); }
        else reject(new Error(response.error || 'The remote session could not be created.'));
      });
      void provider.sendCreateSessionRequest!({requestId, projectId: workspace, targetDeviceId: host, provider: 'claude-code', model: options.model, parentSessionId: options.parentSessionId, initialPrompt, timestamp: Date.now()})
        .catch(error => { clearTimeout(timer); off(); reject(error); });
    });
  }

  async cancel(id: string, workspace: string): Promise<void> {
    const entry = await this.requireEntry(id, workspace);
    if (!this.provider?.sendSessionControlMessage || !this.hostOnline(entry)) throw new Error('The sandbox is offline.');
    const readOnlyReason = this.readOnlyReason(entry);
    if (readOnlyReason) throw new Error(readOnlyReason);
    await this.provider.sendSessionControlMessage({ sessionId: id, type: 'cancel', targetDeviceId: entry.hostDeviceId, timestamp: Date.now(), sentBy: 'desktop' });
  }
}
