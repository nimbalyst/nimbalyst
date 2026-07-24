/**
 * Serialize worker-thread errors so metadata survives postMessage.
 *
 * Error objects lose non-message fields unless copied explicitly.
 * The ambiguous database-lock path depends on `code` plus lock metadata,
 * so the worker and main process share this helper.
 */

export function serializeWorkerError(error) {
  const serialized = {
    message: error instanceof Error ? error.message : String(error),
  };

  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return serialized;
  }

  if (typeof error.name === 'string' && error.name.length > 0) {
    serialized.name = error.name;
  }

  if (typeof error.stack === 'string' && error.stack.length > 0) {
    serialized.stack = error.stack;
  }

  for (const [key, value] of Object.entries(error)) {
    if (value === undefined || typeof value === 'function') {
      continue;
    }
    serialized[key] = value;
  }

  return serialized;
}

export function deserializeWorkerError(serializedError, fallbackMessage) {
  const message =
    serializedError && typeof serializedError.message === 'string'
      ? serializedError.message
      : (fallbackMessage || 'Unknown error');
  const error = new Error(message);

  if (!serializedError || typeof serializedError !== 'object') {
    return error;
  }

  if (typeof serializedError.name === 'string' && serializedError.name.length > 0) {
    error.name = serializedError.name;
  }

  if (typeof serializedError.stack === 'string' && serializedError.stack.length > 0) {
    error.stack = serializedError.stack;
  }

  for (const [key, value] of Object.entries(serializedError)) {
    if (key === 'message' || key === 'name' || key === 'stack') {
      continue;
    }
    error[key] = value;
  }

  return error;
}

