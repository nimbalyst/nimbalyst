export function previewForLog(value: string | undefined, max = 300): string | undefined {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function summarizeNotificationParams(
  method: string,
  paramsUnknown: unknown
): Record<string, unknown> | undefined {
  const params =
    paramsUnknown && typeof paramsUnknown === 'object'
      ? (paramsUnknown as Record<string, unknown>)
      : undefined;
  if (!params) return undefined;

  switch (method) {
    case 'error':
    case 'turn/failed': {
      const errorObj = params.error as
        | { message?: string; codexErrorInfo?: string; additionalDetails?: unknown }
        | undefined;
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        willRetry: params.willRetry,
        message: previewForLog(errorObj?.message),
        codexErrorInfo: previewForLog(errorObj?.codexErrorInfo),
        additionalDetails: errorObj?.additionalDetails,
      };
    }
    case 'warning': {
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        message: previewForLog(params.message as string | undefined),
      };
    }
    case 'turn/completed': {
      const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
      return {
        threadId: params.threadId,
        turnId: turn?.id ?? params.turnId,
        status: turn?.status,
        error: previewForLog(turn?.error?.message),
      };
    }
    case 'mcpServer/startupStatus/updated': {
      return {
        name: params.name,
        status: params.status,
        error: previewForLog((params.error as string | null | undefined) ?? undefined),
      };
    }
    default:
      return undefined;
  }
}

export function extractNotificationRouting(paramsUnknown: unknown): {
  threadId: string | null;
  turnId: string | null;
} {
  if (!paramsUnknown || typeof paramsUnknown !== 'object') {
    return { threadId: null, turnId: null };
  }

  const params = paramsUnknown as {
    threadId?: unknown;
    turnId?: unknown;
    turn?: { id?: unknown };
  };
  const nestedTurnId = params.turn?.id;

  return {
    threadId: typeof params.threadId === 'string' && params.threadId ? params.threadId : null,
    turnId:
      typeof params.turnId === 'string' && params.turnId
        ? params.turnId
        : typeof nestedTurnId === 'string' && nestedTurnId
        ? nestedTurnId
        : null,
  };
}
