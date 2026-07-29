import { describe, it, expect } from 'vitest';
import { planProtocolRegistration } from '../protocolRegistration';

describe('planProtocolRegistration', () => {
    it('skips registration for an unpackaged macOS run so it cannot claim com.github.Electron', () => {
        const plan = planProtocolRegistration({
            platform: 'darwin',
            isDefaultApp: true,
            argv: ['/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', '/repo/packages/electron'],
            execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        });

        expect(plan.action).toBe('skip');
    });

    it('still registers on macOS when NIMBALYST_DEV_PROTOCOL forces it', () => {
        const plan = planProtocolRegistration({
            platform: 'darwin',
            isDefaultApp: true,
            argv: ['/electron', '/repo/packages/electron'],
            execPath: '/electron',
            forceDevRegistration: true,
        });

        expect(plan).toEqual({
            action: 'register-dev',
            execPath: '/electron',
            args: ['/repo/packages/electron'],
        });
    });

    it('registers with execPath and app path for an unpackaged Windows or Linux run', () => {
        for (const platform of ['win32', 'linux'] as const) {
            const plan = planProtocolRegistration({
                platform,
                isDefaultApp: true,
                argv: ['/electron', '/repo/packages/electron', '--workspace', '/tmp/ws'],
                execPath: '/electron',
            });

            expect(plan).toEqual({
                action: 'register-dev',
                execPath: '/electron',
                args: ['/repo/packages/electron'],
            });
        }
    });

    it('registers the packaged bundle on every platform', () => {
        for (const platform of ['darwin', 'win32', 'linux'] as const) {
            const plan = planProtocolRegistration({
                platform,
                isDefaultApp: false,
                argv: ['/Applications/Nimbalyst.app/Contents/MacOS/Nimbalyst'],
                execPath: '/Applications/Nimbalyst.app/Contents/MacOS/Nimbalyst',
            });

            expect(plan).toEqual({ action: 'register-packaged' });
        }
    });

    it('skips a dev run that has no app path to register', () => {
        const plan = planProtocolRegistration({
            platform: 'win32',
            isDefaultApp: true,
            argv: ['/electron'],
            execPath: '/electron',
        });

        expect(plan.action).toBe('skip');
    });
});
