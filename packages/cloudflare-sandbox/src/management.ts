import type { ExecOptions, ProcessStatus, SandboxCommand, SandboxProcess } from '@cloudflare/sandbox';

export const SANDBOX_ID = 'personal';
export const SLEEP_AFTER_SECONDS = 300;

export type ContainerState = {
  status: 'running' | 'healthy' | 'stopping' | 'stopped' | 'stopped_with_code';
  lastChange: number;
  exitCode?: number;
};

export interface SandboxStatus {
  sandboxId: string;
  state: ContainerState['status'];
  lastChangedAt: number;
  sleepAfterSeconds: number;
  persistence: 'ephemeral';
}

export interface SandboxPort {
  getState(): Promise<ContainerState>;
  checkRuntime(keepAlive: boolean): Promise<void>;
  stop(): Promise<void>;
  node: NodePort;
}

export interface ProvisionRequest {
  files: Array<{ path: string; content: string; mode?: number }>;
  allowedHosts: string[];
}
export interface NodeRecord { processId: string | null; startedAt: number; configPath: string }
export type NodeProcess = Pick<SandboxProcess, 'id' | 'status' | 'output' | 'logs' | 'kill' | 'waitForExit'>;
export interface NodeStatus extends SandboxStatus {
  sandboxId: 'personal';
  node: { running: boolean; processId: string | null; startedAt: number | null; exitCode: number | null; recentLog: string };
}
export interface NodePort {
  readRecord(): Promise<NodeRecord | undefined>;
  writeRecord(record: NodeRecord): Promise<void>;
  clearRecord(): Promise<void>;
  setAllowedHosts(hosts: string[]): Promise<void>;
  mkdir(path: string): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: SandboxCommand, options?: ExecOptions): Promise<NodeProcess>;
  exists(path: string): Promise<boolean>;
  getProcess(id: string): Promise<NodeProcess | null>;
  listProcesses(): Promise<ProcessStatus[]>;
  setKeepAlive(value: boolean): Promise<void>;
}
export const BASELINE_ALLOWED_HOSTS = ['github.com', 'api.anthropic.com', 'platform.claude.com', 'console.anthropic.com', 'sync.nimbalyst.com'];
function homePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/home/nimbalyst/')
    || value.split('/').includes('..') || /[\x00-\x1f\x7f\\]/.test(value)) throw new Error('invalid-path');
  const path = value.split('/').filter(part => part && part !== '.').join('/');
  if (path === 'home/nimbalyst') throw new Error('invalid-path');
  return `/${path}`;
}
const nodeCommand = (configPath: string): SandboxCommand => ['/usr/local/bin/nimbalyst-node', 'serve', '--config', configPath];
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;

/** Serialize lifecycle mutations on the sandbox DO, including across callers. */
export class SandboxManagement {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly sandbox: SandboxPort) {}

  async status(): Promise<SandboxStatus> {
    // Checking state must never execute a command or keep an idle container awake.
    const state = await this.sandbox.getState();
    return {
      sandboxId: SANDBOX_ID,
      state: state.status,
      lastChangedAt: state.lastChange,
      sleepAfterSeconds: SLEEP_AFTER_SECONDS,
      persistence: 'ephemeral',
    };
  }

  wake(): Promise<SandboxStatus> {
    return this.serialize(async () => {
      await this.sandbox.checkRuntime((await this.observeNode()).node.running);
      return this.status();
    });
  }

  stop(request: unknown): Promise<SandboxStatus> {
    if (!request || typeof request !== 'object'
      || (request as { discardEphemeralData?: unknown }).discardEphemeralData !== true) {
      return Promise.reject(new Error('Stopping requires confirmation that ephemeral files and processes will be lost.'));
    }
    return this.serialize(async () => {
      await this.sandbox.stop();
      // A sent signal is not evidence the container stopped. Preserve observed state.
      return this.status();
    });
  }

  provision(request: ProvisionRequest): Promise<NodeStatus> {
    return this.serialize(async () => {
      if (!request || !Array.isArray(request.files) || !Array.isArray(request.allowedHosts)
        || request.files.length > 32 || request.allowedHosts.length > 16) throw new Error('invalid-request');
      let size = 0;
      const files = request.files.map(file => {
        const path = homePath(file?.path);
        if (typeof file.content !== 'string') throw new Error('invalid-request');
        size += new TextEncoder().encode(file.content).byteLength;
        const mode = file.mode ?? 0o600;
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('invalid-request');
        return { path, content: file.content, mode };
      });
      if (size > 256 * 1024) throw new Error('invalid-request');
      // Deliberately accept concrete DNS hosts only, never URLs or catch-all patterns.
      if (request.allowedHosts.some(host => typeof host !== 'string' || host.length > 253
        || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(host))) throw new Error('invalid-request');
      try {
        // Complete preflight before changing any files or the outbound policy.
        for (const file of files) await this.checkPath(file.path);
        await this.sandbox.node.setAllowedHosts([...new Set([...BASELINE_ALLOWED_HOSTS, ...request.allowedHosts.map(host => host.toLowerCase())])]);
        for (const file of files) {
          await this.sandbox.node.mkdir(file.path.slice(0, file.path.lastIndexOf('/')));
          if (!await this.commandSucceeded(['/usr/bin/install', '-m', '600', '--', '/dev/null', file.path])) throw new Error('invalid-path');
          try {
            await this.sandbox.node.writeFile(file.path, file.content);
            if (!await this.commandSucceeded(['/usr/bin/chmod', file.mode.toString(8), '--', file.path])) throw new Error('invalid-path');
          } catch (error) {
            await this.commandSucceeded(['/usr/bin/rm', '-f', '--', file.path]);
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid-path') throw error;
        throw new Error('node-not-provisioned');
      }
      return this.observeNode();
    });
  }

  startNode(request: { configPath: string }): Promise<NodeStatus> {
    return this.serialize(async () => {
      const path = homePath(request?.configPath);
      const current = await this.observeNode();
      if (current.node.running) return current;
      await this.checkPath(path);
      if (!await this.sandbox.node.exists(path)) throw new Error('node-not-provisioned');
      try {
        // Persist the job before launch: an interrupted RPC can start work without
        // returning an ID. Later observations reconcile it instead of replaying.
        await this.sandbox.node.writeRecord({ processId: null, startedAt: Date.now(), configPath: path });
        const process = await this.sandbox.node.exec(nodeCommand(path));
        const observed = await process.status();
        const record = { processId: process.id, startedAt: Date.parse(observed.startedAt), configPath: path };
        try {
          await this.sandbox.node.writeRecord(record);
        } catch {
          // A process we cannot track must not be left serving in the background.
          try {
            await process.kill(15);
          } catch {
            // A transient storage failure must not hide a process we could not stop.
            await this.sandbox.node.writeRecord(record);
          }
          throw new Error('node-start-failed');
        }
        await this.sandbox.node.setKeepAlive(true);
        const status = await this.observeNode();
        if (!status.node.running) {
          await this.sandbox.node.setKeepAlive(false);
          throw new Error('node-start-failed');
        }
        return status;
      } catch {
        // Keep the persisted job for reconciliation; never replay an uncertain launch.
        // SDK diagnostics are not part of the desktop's public error contract.
        throw new Error('node-start-failed');
      }
    });
  }

  nodeStatus(): Promise<NodeStatus> { return this.serialize(() => this.observeNode()); }

  stopNode(request: unknown): Promise<NodeStatus> {
    if (!request || typeof request !== 'object' || (request as { discardEphemeralData?: unknown }).discardEphemeralData !== true) {
      return Promise.reject(new Error('Stopping requires confirmation that ephemeral files and processes will be lost.'));
    }
    return this.serialize(async () => {
      let status = await this.observeNode();
      if (status.state === 'stopping') return status;
      if (status.node.running && status.node.processId) {
        try {
          const process = await this.sandbox.node.getProcess(status.node.processId);
          if (process) {
            await process.kill(15);
            await process.waitForExit({ timeout: 500 });
          }
        } catch (error) {
          // A timeout leaves the process alive; a stale handle belongs to a replaced
          // container. Re-observe both without starting or killing a replacement.
          if (!['PROCESS_WAIT_TIMEOUT', 'STALE_PROCESS_HANDLE'].includes(String(errorCode(error)))) throw error;
        }
        status = await this.observeNode();
        // Retain the record if SIGTERM has not completed; never lose track of a live node.
        if (status.node.running) return status;
      }
      if (['running', 'healthy'].includes(status.state)) await this.sandbox.node.setKeepAlive(false);
      if (status.node.processId) await this.sandbox.node.clearRecord();
      return { ...status, node: { ...status.node, processId: null, startedAt: null } };
    });
  }

  private async checkPath(path: string): Promise<void> {
    // Reject symlinks in every component before writes or config execution.
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (!await this.commandSucceeded(['/usr/bin/test', '!', '-L', '/' + parts.slice(0, i + 1).join('/')])) throw new Error('invalid-path');
    }
  }

  private async commandSucceeded(argv: SandboxCommand): Promise<boolean> {
    const process = await this.sandbox.node.exec(argv, { timeout: 30_000 });
    const output = await process.output({ encoding: 'utf8', maxBytes: 4096 });
    return output.exitCode === 0 && !output.timedOut;
  }

  private async observeNode(): Promise<NodeStatus> {
    const status = await this.status();
    let record = await this.sandbox.node.readRecord();
    const node: NodeStatus['node'] = { running: false, processId: record?.processId ?? null, startedAt: record?.startedAt ?? null, exitCode: null, recentLog: '' };
    if (record && ['running', 'healthy'].includes(status.state)) {
      let process: NodeProcess | null = null;
      // Records from the stable protocol lack the job and cannot identify a preview process.
      if (typeof record.configPath === 'string') {
        if (record.processId === null) {
          const command = JSON.stringify(nodeCommand(record.configPath));
          const candidates = (await this.sandbox.node.listProcesses()).filter(candidate =>
            JSON.stringify(candidate.command) === command && Date.parse(candidate.startedAt) >= record!.startedAt);
          if (candidates.length > 1) throw new Error('node-start-failed');
          if (candidates.length === 1) {
            record = { ...record, processId: candidates[0].id, startedAt: Date.parse(candidates[0].startedAt) };
            await this.sandbox.node.writeRecord(record);
            node.processId = record.processId;
            node.startedAt = record.startedAt;
          }
        }
        try { process = record.processId ? await this.sandbox.node.getProcess(record.processId) : null; }
        catch (error) { if (errorCode(error) !== 'STALE_PROCESS_HANDLE') throw error; }
      }
      if (process) {
        let observed;
        try { observed = await process.status(); }
        catch (error) { if (errorCode(error) !== 'STALE_PROCESS_HANDLE') throw error; }
        // IDs are container-local. Match both the job and its start, never just an ID.
        const sameJob = observed && Date.parse(observed.startedAt) === record.startedAt
          && JSON.stringify(observed.command) === JSON.stringify(nodeCommand(record.configPath));
        node.running = !!sameJob && observed?.state === 'running';
        node.exitCode = sameJob && observed?.state === 'exited' ? observed.exit.code : null;
        try {
          let bytes = new Uint8Array();
          if (sameJob) {
            const stream = await process.logs({ replay: true, follow: false });
            const reader = stream.getReader();
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value.type !== 'stdout' && value.type !== 'stderr') continue;
                const tail = value.data.slice(-4096);
                const joined = new Uint8Array(Math.min(4096, bytes.length + tail.length));
                const prefix = bytes.slice(-(joined.length - tail.length));
                if (joined.length > tail.length) joined.set(prefix);
                joined.set(tail, joined.length - tail.length);
                bytes = joined;
              }
            } finally { await reader.cancel(); reader.releaseLock(); }
          }
          node.recentLog = new TextDecoder().decode(bytes);
          // Replacement characters at the byte boundary can expand on re-encoding.
          while (new TextEncoder().encode(node.recentLog).byteLength > 4096) {
            node.recentLog = node.recentLog.slice((node.recentLog.codePointAt(0) ?? 0) > 0xffff ? 2 : 1);
          }
        } catch {
          // Log transport failure must not prevent stopping an observed process.
          node.recentLog = 'Recent logs are unavailable.';
        }
      }
      if (!node.running) {
        await this.sandbox.node.setKeepAlive(false);
        await this.sandbox.node.clearRecord();
        node.processId = null;
        node.startedAt = null;
      }
    }
    return { ...status, sandboxId: SANDBOX_ID, node };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
