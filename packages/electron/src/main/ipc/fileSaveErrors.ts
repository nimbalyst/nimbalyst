export type FileSaveSource = 'auto' | 'manual';

export type FileSaveErrorType =
  | 'permission'
  | 'not_found'
  | 'disk_full'
  | 'is_directory'
  | 'resource_limit'
  | 'io'
  | 'invalid_path'
  | 'unknown';

export interface ClassifiedFileSaveError {
  errorCode: string;
  errorType: FileSaveErrorType;
}

const MAX_TRACKED_FAILURES = 1_000;
const ERROR_TYPES_BY_CODE: Readonly<Record<string, FileSaveErrorType>> = {
  EACCES: 'permission',
  EPERM: 'permission',
  EROFS: 'permission',
  ENOENT: 'not_found',
  ENOSPC: 'disk_full',
  EDQUOT: 'disk_full',
  EISDIR: 'is_directory',
  EMFILE: 'resource_limit',
  ENFILE: 'resource_limit',
  EBUSY: 'resource_limit',
  ETXTBSY: 'resource_limit',
  EIO: 'io',
  ENXIO: 'io',
  EINVAL: 'invalid_path',
  ENAMETOOLONG: 'invalid_path',
  ENOTDIR: 'invalid_path',
  ELOOP: 'invalid_path',
};

/**
 * Classify filesystem failures exclusively from stable Node error codes.
 * Error messages may contain user paths or document names, so they are never
 * parsed or forwarded to analytics.
 */
export function classifyFileSaveError(error: unknown): ClassifiedFileSaveError {
  const rawCode = typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
      ? error.code.toUpperCase()
      : 'UNKNOWN';
  const errorType = ERROR_TYPES_BY_CODE[rawCode];

  if (!errorType) {
    return {
      errorCode: 'UNKNOWN',
      errorType: 'unknown',
    };
  }

  return {
    errorCode: rawCode,
    errorType,
  };
}

export function normalizeFileSaveSource(source: unknown): FileSaveSource {
  return source === 'auto' ? 'auto' : 'manual';
}

export function getFileSaveSourceAnalytics(source: FileSaveSource): {
  saveType: FileSaveSource;
  isAutoSave: boolean;
} {
  return {
    saveType: source,
    isAutoSave: source === 'auto',
  };
}

/**
 * Deduplicates a continuous failure incident without emitting file paths.
 * A successful save rearms telemetry for that file so a later
 * regression remains observable.
 */
export class FileSaveFailureTelemetryDeduper {
  private readonly activeFailures = new Set<string>();

  shouldReport(filePath: string, source: FileSaveSource, errorCode: string): boolean {
    const key = this.failureKey(filePath, source, errorCode);
    if (this.activeFailures.has(key)) return false;
    if (this.activeFailures.size >= MAX_TRACKED_FAILURES) {
      const oldestKey = this.activeFailures.values().next().value;
      if (oldestKey) this.activeFailures.delete(oldestKey);
    }
    this.activeFailures.add(key);
    return true;
  }

  markSuccess(filePath: string): void {
    const pathToken = `\u0000${filePath}\u0000`;
    for (const key of this.activeFailures) {
      if (key.includes(pathToken)) {
        this.activeFailures.delete(key);
      }
    }
  }

  private failurePrefix(filePath: string, source: FileSaveSource): string {
    return `${source}\u0000${filePath}\u0000`;
  }

  private failureKey(filePath: string, source: FileSaveSource, errorCode: string): string {
    return `${this.failurePrefix(filePath, source)}${errorCode}`;
  }
}
