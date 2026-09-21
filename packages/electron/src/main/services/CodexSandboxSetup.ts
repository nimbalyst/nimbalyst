import type { EventEmitter } from 'node:events';
import type { WindowsSandboxMode, WindowsSandboxState } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/windowsSandbox';

export interface SandboxConnection {
  child: EventEmitter;
  client: {
    request(method: string, params: unknown): Promise<unknown>;
    onNotification(handler: (method: string, params: unknown) => void): () => void;
  };
}

interface Dependencies {
  connect(): Promise<SandboxConnection>;
  reset(): void;
  ready(): void;
  changed(state: WindowsSandboxState): void;
}

/** One setup per connection: Codex completion notifications have no request ID. */
export class CodexSandboxSetup {
  state: WindowsSandboxState = { phase: 'idle' };
  constructor(private readonly deps: Dependencies) {}

  private publish(state: WindowsSandboxState): void {
    this.state = state;
    this.deps.changed(state);
  }

  async status(refreshAfterSetup = false): Promise<WindowsSandboxState> {
    if (this.state.phase === 'running' && !refreshAfterSetup) return this.state;
    const { client } = await this.deps.connect();
    const response = await client.request('windowsSandbox/readiness', {}) as { status?: string };
    const { requirements } = await client.request('configRequirements/read', {}) as {
      requirements: { allowedWindowsSandboxImplementations?: WindowsSandboxMode[] } | null;
    };
    if (response.status !== 'ready' && response.status !== 'notConfigured' && response.status !== 'updateRequired') {
      throw new Error('Codex returned an unsupported Windows sandbox readiness response.');
    }
    const modes = requirements?.allowedWindowsSandboxImplementations;
    if (modes && (!Array.isArray(modes) || modes.some(mode => mode !== 'elevated' && mode !== 'unelevated'))) throw new Error('Codex returned unsupported managed sandbox modes.');
    // A status request can overlap a user starting setup.
    this.publish({ ...this.state, ...(this.state.phase === 'running' ? {} : { phase: 'idle' as const, error: undefined }), readiness: response.status, allowedModes: modes ?? ['elevated', 'unelevated'] });
    return this.state;
  }

  async start(mode: WindowsSandboxMode, cwd: string): Promise<WindowsSandboxState> {
    if (this.state.phase === 'running') throw new Error('Windows sandbox setup is already running.');
    if (mode !== 'elevated' && mode !== 'unelevated') throw new Error('Invalid Windows sandbox mode.');
    if (!cwd) throw new Error('A workspace is required for Windows sandbox setup.');
    this.publish({ ...this.state, phase: 'running', error: undefined });
    let dispose = () => {};
    try {
      const { client, child } = await this.deps.connect();
      const completed = new Promise<void>((resolve, reject) => {
        const stop = () => reject(new Error('Codex stopped before Windows sandbox setup completed.'));
        const timeout = setTimeout(() => reject(new Error('Windows sandbox setup timed out. Windows may still finish setup; check its status before retrying.')), 120_000);
        const unsubscribe = client.onNotification((method, params) => {
          if (method !== 'windowsSandbox/setupCompleted') return;
          const result = params as { mode?: string; success?: boolean; error?: string };
          if (result.mode !== mode) return;
          if (result.success === true) resolve();
          else reject(new Error(result.error || 'Windows sandbox setup failed or was cancelled.'));
        });
        for (const event of ['exit', 'close', 'error']) child.once(event, stop);
        dispose = () => {
          clearTimeout(timeout);
          unsubscribe();
          for (const event of ['exit', 'close', 'error']) child.removeListener(event, stop);
        };
      });
      // Subscribe before requesting: completion can arrive before the acknowledgement.
      await Promise.all([
        completed,
        client.request('windowsSandbox/setupStart', { mode, cwd }).then(response => {
          if ((response as { started?: boolean }).started !== true) throw new Error('Codex did not start Windows sandbox setup.');
        }),
      ]);
      dispose();
      this.deps.reset(); // readiness in the old child holds a stale config snapshot
      this.deps.ready(); // active turns finish; their next turn reattaches the same thread
      await this.status(true);
      this.publish({ ...this.state, phase: 'idle', error: undefined });
      return this.state;
    } catch (error) {
      dispose();
      this.deps.reset(); // late completion cannot be attributed to the next attempt
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ ...this.state, phase: 'error', error: message });
      throw error;
    } finally {
      dispose();
    }
  }
}
