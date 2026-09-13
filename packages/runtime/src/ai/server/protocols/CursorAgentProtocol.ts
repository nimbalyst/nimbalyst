/**
 * Cursor Agent headless protocol adapter.
 *
 * Transport: `cursor-agent --print --output-format stream-json`, one process
 * per turn, with session continuity via `create-chat` + `--resume <chatId>`.
 *
 * The `agent acp` subcommand referenced in Cursor's docs does not exist in the
 * shipped CLI (`2026.08.25`), and would be the wrong surface regardless:
 * stream-json is the only surface of the three agents measured in Phase 0 that
 * reports a *pre-edit baseline*. `editToolCall.result.success` carries
 * `beforeFullFileContent`, `afterFullFileContent` and a unified `diffString`,
 * and `deleteToolCall.result.success.prevContent` carries the contents of a
 * file it removed. That is better data than a filesystem watcher can infer,
 * which is what earns this provider `'structured'` file-change fidelity.
 *
 * Observed record types (2026-08-26):
 *   {type:'system', subtype:'init', session_id, cwd, model, permissionMode}
 *   {type:'thinking', subtype:'delta'|'completed', text}
 *   {type:'tool_call', subtype:'started'|'completed', call_id, tool_call:{<oneof>ToolCall}}
 *   {type:'assistant', message|text}
 *   {type:'result', subtype:'success'|..., result, usage, session_id}
 */

import {
  runHeadlessNdjson,
  HeadlessNdjsonExitError,
} from './headless/HeadlessNdjsonProcess';
import { mapCursorRecord } from './headless/CursorAgentRecordMapper';
import type {
  AgentProtocol,
  ProtocolEvent,
  ProtocolMessage,
  ProtocolSession,
  SessionOptions,
} from './ProtocolInterface';

export { mapCursorRecord } from './headless/CursorAgentRecordMapper';

const PLATFORM = 'cursor-agent-headless';

interface CursorSessionRaw extends Record<string, unknown> {
  workspacePath: string;
  model?: string;
}

export interface CursorAgentProtocolDeps {
  runNdjson?: typeof runHeadlessNdjson;
  /** Runs `cursor-agent create-chat` and returns the new chat id. */
  createChat?: (opts: { command: string; cwd: string; env?: Record<string, string> }) => Promise<string>;
}

export class CursorAgentProtocol implements AgentProtocol {
  readonly platform = PLATFORM;

  private cursorPath = 'cursor-agent';
  private processEnv: Record<string, string> | null = null;
  private readonly runNdjson: typeof runHeadlessNdjson;
  private readonly createChatImpl: NonNullable<CursorAgentProtocolDeps['createChat']>;

  constructor(deps?: CursorAgentProtocolDeps) {
    this.runNdjson = deps?.runNdjson ?? runHeadlessNdjson;
    this.createChatImpl = deps?.createChat ?? defaultCreateChat;
  }

  setCursorPath(executablePath: string): void {
    this.cursorPath = executablePath;
  }

  setProcessEnv(env: Record<string, string> | null): void {
    this.processEnv = env;
  }

  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    // `create-chat` mints the id up front so the host can persist a provider
    // session id before the first turn runs. Without it the id only appears in
    // the first `system.init` record, and a turn that dies early would leave
    // the session unresumable.
    const id = await this.createChatImpl({
      command: this.cursorPath,
      cwd: options.workspacePath,
      env: this.processEnv ?? undefined,
    });
    return {
      id,
      platform: PLATFORM,
      raw: { workspacePath: options.workspacePath, model: options.model } satisfies CursorSessionRaw,
    };
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    return {
      id: sessionId,
      platform: PLATFORM,
      raw: { workspacePath: options.workspacePath, model: options.model } satisfies CursorSessionRaw,
    };
  }

  async forkSession(_sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    // Cursor has no fork RPC. A fresh chat is the honest fallback: it starts
    // empty rather than silently sharing history with the source.
    return this.createSession(options);
  }

  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage,
  ): AsyncIterable<ProtocolEvent> {
    const raw = (session.raw ?? {}) as CursorSessionRaw;
    const args = this.buildArgs(session, raw, message);

    let sawResult = false;
    try {
      for await (const item of this.runNdjson({
        command: this.cursorPath,
        args,
        cwd: raw.workspacePath,
        env: this.processEnv ?? undefined,
        abortSignal: message.abortSignal,
      })) {
        if (item.kind === 'garbage') continue;
        yield { type: 'raw_event', metadata: { rawEvent: item.value } };

        for (const event of mapCursorRecord(item.value)) {
          if (event.type === 'complete') sawResult = true;
          yield event;
        }
      }
    } catch (error) {
      if (message.abortSignal?.aborted) return;
      yield { type: 'error', error: describeCursorFailure(error, this.cursorPath) };
      return;
    }

    if (!sawResult && !message.abortSignal?.aborted) {
      yield { type: 'error', error: 'Cursor ended the turn without a final result.' };
    }
  }

  abortSession(_session: ProtocolSession): void {
    // Per-turn child process; the per-message abort signal owns teardown.
  }

  cleanupSession(_session: ProtocolSession): void {
    // Cursor owns its chat storage; deleting it is not ours to do.
  }

  private buildArgs(
    session: ProtocolSession,
    raw: CursorSessionRaw,
    message: ProtocolMessage,
  ): string[] {
    const args = [
      '--resume', session.id,
      '-p',
      '--output-format', 'stream-json',
    ];
    // Stored model ids are namespaced (`cursor-agent:auto`); the CLI wants the
    // bare id.
    if (raw.model) args.push('--model', stripProviderNamespace(raw.model));
    // `--print` already grants write and shell access with no approval event
    // to intercept (measured: a run without `--force` still edited the file).
    // `--force` makes that explicit rather than leaving it implicit, and
    // `--trust` avoids a workspace prompt no one can answer headlessly.
    // Nimbalyst gates the turn up front instead; the settings panel says so.
    args.push('--force', '--trust');
    // The prompt is positional; leading dashes must never become CLI options.
    args.push('--', message.content);
    return args;
  }
}

function stripProviderNamespace(modelId: string): string {
  const separator = modelId.indexOf(':');
  return separator === -1 ? modelId : modelId.slice(separator + 1);
}

async function defaultCreateChat(opts: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
}): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise<string>((resolve, reject) => {
    // An explicit callback rather than promisify(execFile): a `promisify.custom`
    // on the mocked module would bypass the spy at test boundaries.
    execFile(
      opts.command,
      ['create-chat'],
      { cwd: opts.cwd, env: opts.env, timeout: 30_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const id = String(stdout).trim().split('\n').pop()?.trim();
        if (!id) {
          reject(new Error('cursor-agent create-chat returned no chat id'));
          return;
        }
        resolve(id);
      },
    );
  });
}

function describeCursorFailure(error: unknown, executablePath: string): string {
  if (error instanceof HeadlessNdjsonExitError) {
    const stderr = error.stderr.toLowerCase();
    if (/not logged in|unauthorized|authentication/.test(stderr)) {
      return 'Cursor is not logged in. Run `cursor-agent login` in your terminal, then try again.';
    }
    return error.message;
  }
  const messageText = error instanceof Error ? error.message : String(error);
  if (['E2BIG', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException)?.code ?? '') || /\b(?:E2BIG|ENAMETOOLONG)\b/i.test(messageText)) {
    return 'Cursor prompt was too large to start the CLI. Shorten the prompt or reduce the attached document context and try again.';
  }
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /\bENOENT\b/i.test(messageText)) {
    return 'The Cursor CLI was not found. Install it with:\n\n'
      + '  curl -fsSL https://cursor.com/install | bash\n\n'
      + 'Then run `cursor-agent login` to authenticate.';
  }
  if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '') || /\b(?:EACCES|EPERM)\b/i.test(messageText)) {
    return `The Cursor CLI was found at "${executablePath}" but is not executable. Check its execution permissions or reinstall the CLI, then try again.`;
  }
  return messageText;
}
