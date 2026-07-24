export interface SerializedWorkerError {
  message: string;
  name?: string;
  stack?: string;
  [key: string]: unknown;
}

export function serializeWorkerError(error: unknown): SerializedWorkerError;

export function deserializeWorkerError(
  serializedError: SerializedWorkerError | undefined,
  fallbackMessage?: string
): Error;
