export type CodexTextInput = {
  type: 'text';
  text: string;
};

export type CodexLocalImageInput = {
  type: 'local_image';
  path: string;
};

export type CodexInput = string | Array<CodexTextInput | CodexLocalImageInput>;

export interface CodexThreadLike {
  id?: string;
  runStreamed(
    input: CodexInput,
    options?: Record<string, unknown>
  ): Promise<{ events?: AsyncIterable<any>; threadId?: string; thread_id?: string } | AsyncIterable<any>>;
}

export interface CodexClientLike {
  startThread(options?: Record<string, unknown>): CodexThreadLike;
  resumeThread(threadId: string, options?: Record<string, unknown>): CodexThreadLike;
}

export interface CodexSdkModuleLike {
  Codex: new (options?: Record<string, unknown>) => CodexClientLike;
}

function isModuleWithCodexClass(moduleValue: unknown): moduleValue is CodexSdkModuleLike {
  return !!moduleValue && typeof (moduleValue as any).Codex === 'function';
}

export async function loadCodexSdkModule(): Promise<CodexSdkModuleLike> {
  try {
    const sdkModule = await import('@openai/codex-sdk');
    if (isModuleWithCodexClass(sdkModule)) {
      return sdkModule;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load @openai/codex-sdk. Install it with "npm install @openai/codex-sdk". Details: ${message}`
    );
  }

  throw new Error('Loaded @openai/codex-sdk, but no Codex class export was found');
}

function isAsyncIterable(value: unknown): value is AsyncIterable<any> {
  return !!value && typeof (value as any)[Symbol.asyncIterator] === 'function';
}

export function getEventsIterable(
  runResult: { events?: AsyncIterable<any> } | AsyncIterable<any>
): AsyncIterable<any> {
  if (isAsyncIterable(runResult)) {
    return runResult;
  }

  if (runResult && isAsyncIterable(runResult.events)) {
    return runResult.events;
  }

  throw new Error('Codex SDK did not return a valid events stream');
}

export function getThreadIdFromRunResult(runResult: unknown): string | undefined {
  if (!runResult || typeof runResult !== 'object') {
    return undefined;
  }

  const resultAsAny = runResult as Record<string, unknown>;
  if (typeof resultAsAny.threadId === 'string' && resultAsAny.threadId) {
    return resultAsAny.threadId;
  }
  if (typeof resultAsAny.thread_id === 'string' && resultAsAny.thread_id) {
    return resultAsAny.thread_id;
  }
  if (typeof resultAsAny.id === 'string' && resultAsAny.id) {
    return resultAsAny.id;
  }
  return undefined;
}
