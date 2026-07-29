import path from 'path';

/**
 * Decides how (or whether) to claim the `nimbalyst://` URL scheme with the OS.
 *
 * The macOS dev case is the reason this is a separate, tested function. On macOS
 * `app.setAsDefaultProtocolClient(scheme, execPath, args)` IGNORES execPath/args --
 * Electron registers the *running bundle's* identifier, which for an unpackaged dev
 * run is the generic `com.github.Electron` shipped by every copy of Electron in every
 * `node_modules`. A machine with several checkouts/worktrees has a dozen bundles
 * claiming that id, so the OS routes `nimbalyst://` to an arbitrary one and launches
 * it with no app path -- the blank Electron welcome window, and a deep link that never
 * reaches Nimbalyst. Worse, every dev launch (including the short-lived instance that
 * forwards a deep link) re-registered it, stomping any correct handler.
 *
 * Dev deep links on macOS are instead routed by a dedicated handler bundle with its own
 * identifier -- see `scripts/install-dev-url-handler.sh`.
 */
export type ProtocolRegistrationPlan =
    | { action: 'register-packaged' }
    | { action: 'register-dev'; execPath: string; args: string[] }
    | { action: 'skip'; reason: string };

export interface ProtocolRegistrationInput {
    platform: NodeJS.Platform;
    /** `process.defaultApp` -- true when Electron was started with an app path (dev). */
    isDefaultApp: boolean;
    argv: string[];
    execPath: string;
    /** `NIMBALYST_DEV_PROTOCOL=1` escape hatch to force the legacy dev registration. */
    forceDevRegistration?: boolean;
}

export function planProtocolRegistration(input: ProtocolRegistrationInput): ProtocolRegistrationPlan {
    if (!input.isDefaultApp) {
        return { action: 'register-packaged' };
    }

    if (input.argv.length < 2) {
        return { action: 'skip', reason: 'dev run has no app path in argv' };
    }

    if (input.platform === 'darwin' && !input.forceDevRegistration) {
        return {
            action: 'skip',
            reason:
                'macOS dev run would claim the generic com.github.Electron bundle id, which every ' +
                'Electron checkout shares -- run scripts/install-dev-url-handler.sh instead ' +
                '(NIMBALYST_DEV_PROTOCOL=1 forces the old behavior)',
        };
    }

    return {
        action: 'register-dev',
        execPath: input.execPath,
        args: [path.resolve(input.argv[1])],
    };
}
