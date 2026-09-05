// @vitest-environment node

/**
 * A minimal PanelHost double for adapter and index tests.
 *
 * Only the three surfaces the data layer is allowed to touch are modelled:
 * `data.query`, `exec`, and `storage`. Everything else on PanelHost is absent,
 * which is deliberate — a test that needs more is a test whose subject reached
 * outside the contract.
 *
 * `query` and `exec` are routed through caller-supplied matchers so a test can
 * make one statement fail while the others succeed; that partial-failure case
 * is the one adapters get wrong.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';

export interface QueryCall {
  sql: string;
  params: unknown[];
}

export interface ExecCall {
  command: string;
}

export type QueryHandler = (call: QueryCall) => unknown[] | Promise<unknown[]>;
export type ExecHandler = (
  call: ExecCall,
) =>
  | { success?: boolean; stdout?: string; stderr?: string; exitCode?: number }
  | Promise<{ success?: boolean; stdout?: string; stderr?: string; exitCode?: number }>
  | undefined;

export interface TestHostOptions {
  workspacePath?: string;
  /** Ordered matchers; the first whose `match` hits handles the query. */
  queries?: Array<{ match: RegExp; handle: QueryHandler }>;
  /** Ordered matchers; the first whose `match` hits handles the command. */
  execs?: Array<{ match: RegExp; handle: ExecHandler }>;
  /** Omit to make `host.data` absent entirely (the "no permission" case). */
  withData?: boolean;
  storage?: Map<string, unknown>;
}

export interface TestHost {
  host: PanelHost;
  queryCalls: QueryCall[];
  execCalls: ExecCall[];
  storage: Map<string, unknown>;
}

const DEFAULT_WORKSPACE = '/ws';

export function createTestHost(options: TestHostOptions = {}): TestHost {
  const workspacePath = options.workspacePath ?? DEFAULT_WORKSPACE;
  const queryCalls: QueryCall[] = [];
  const execCalls: ExecCall[] = [];
  const store = options.storage ?? new Map<string, unknown>();

  const query = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const call = { sql, params };
    queryCalls.push(call);
    for (const { match, handle } of options.queries ?? []) {
      if (match.test(sql)) return (await handle(call)) as T[];
    }
    return [] as T[];
  };

  const exec = async (command: string) => {
    const call = { command };
    execCalls.push(call);
    for (const { match, handle } of options.execs ?? []) {
      if (!match.test(command)) continue;
      const res = await handle(call);
      if (res === undefined) continue;
      return {
        success: res.success ?? true,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        exitCode: res.exitCode ?? (res.success === false ? 1 : 0),
      };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  const storage = {
    get: <T,>(key: string) => store.get(key) as T | undefined,
    set: async <T,>(key: string, value: T) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    getGlobal: <T,>(key: string) => store.get(`global:${key}`) as T | undefined,
    setGlobal: async <T,>(key: string, value: T) => {
      store.set(`global:${key}`, value);
    },
    deleteGlobal: async (key: string) => {
      store.delete(`global:${key}`);
    },
    getSecret: async () => undefined,
    setSecret: async () => {},
    deleteSecret: async () => {},
  };

  const host = {
    workspacePath,
    exec,
    storage,
    ...(options.withData === false ? {} : { data: { query } }),
  } as unknown as PanelHost;

  return { host, queryCalls, execCalls, storage: store };
}

/** Build a `git log --name-only` style block the git adapter/source parses. */
export function gitLogBlock(
  hash: string,
  subject: string,
  author: string,
  isoDate: string,
  files: string[] = [],
): string {
  return `__COMMIT__${hash}\x1F${subject}\x1F${author}\x1F${isoDate}\n${files.join('\n')}\n`;
}
