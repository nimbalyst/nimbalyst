export type SingleInstanceLifecycleMode =
  | 'multiple-instance-owner'
  | 'single-instance-primary'
  | 'single-instance-secondary';

export interface SingleInstanceLifecycleOwnership {
  mode: SingleInstanceLifecycleMode;
  ownsPrimaryLifecycle: boolean;
}

interface ResolveSingleInstanceLifecycleOwnershipOptions {
  allowMultipleInstances: boolean;
  acquiredSingleInstanceLock: boolean | null;
}

export function resolveSingleInstanceLifecycleOwnership({
  allowMultipleInstances,
  acquiredSingleInstanceLock,
}: ResolveSingleInstanceLifecycleOwnershipOptions): SingleInstanceLifecycleOwnership {
  if (allowMultipleInstances) {
    return {
      mode: 'multiple-instance-owner',
      ownsPrimaryLifecycle: true,
    };
  }

  if (acquiredSingleInstanceLock === null) {
    throw new Error('Packaged single-instance lifecycle requires a lock result');
  }

  return acquiredSingleInstanceLock
    ? {
        mode: 'single-instance-primary',
        ownsPrimaryLifecycle: true,
      }
    : {
        mode: 'single-instance-secondary',
        ownsPrimaryLifecycle: false,
      };
}

export function runIfSingleInstanceLifecycleOwner(
  ownership: SingleInstanceLifecycleOwnership,
  effect: () => void,
): boolean {
  if (!ownership.ownsPrimaryLifecycle) {
    return false;
  }

  effect();
  return true;
}

export type LosingSecondaryControlPathResult =
  | 'relayed-argv-file'
  | 'deep-link-exit'
  | 'waiting-for-open-file';

interface StartLosingSecondaryControlPathOptions {
  argv: readonly string[];
  isAbsolutePath: (candidate: string) => boolean;
  relayFile: (filePath: string) => void;
  registerOpenFileHandler: (handler: (filePath: string) => void) => void;
  scheduleExitTimeout: (handler: () => void, delayMs: number) => void;
  quit: () => void;
  onDeepLinkExit?: () => void;
  onTimeoutExit?: () => void;
}

export function startLosingSecondaryControlPath({
  argv,
  isAbsolutePath,
  relayFile,
  registerOpenFileHandler,
  scheduleExitTimeout,
  quit,
  onDeepLinkExit,
  onTimeoutExit,
}: StartLosingSecondaryControlPathOptions): LosingSecondaryControlPathResult {
  let settled = false;

  const relayAndExit = (filePath: string): void => {
    if (settled) return;
    settled = true;
    relayFile(filePath);
    quit();
  };

  const exitWithoutRelay = (): void => {
    if (settled) return;
    settled = true;
    quit();
  };

  const fileArg = argv.find(
    (arg) =>
      !arg.startsWith('-') &&
      arg !== argv[0] &&
      isAbsolutePath(arg),
  );

  if (fileArg) {
    relayAndExit(fileArg);
    return 'relayed-argv-file';
  }

  if (argv.some((arg) => arg.startsWith('nimbalyst://'))) {
    onDeepLinkExit?.();
    exitWithoutRelay();
    return 'deep-link-exit';
  }

  registerOpenFileHandler(relayAndExit);
  scheduleExitTimeout(() => {
    if (settled) return;
    onTimeoutExit?.();
    exitWithoutRelay();
  }, 5000);

  return 'waiting-for-open-file';
}
