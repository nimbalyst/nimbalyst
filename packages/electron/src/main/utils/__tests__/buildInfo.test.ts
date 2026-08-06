import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBuildInfo } from '../buildInfo';

describe('getBuildInfo', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        delete process.env.BUILD_COMMIT_HASH;
        delete process.env.BUILD_DATE;
        delete process.env.OFFICIAL_BUILD;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('sources version from the passed-in app version', () => {
        expect(getBuildInfo('0.71.2').version).toBe('0.71.2');
    });

    it('falls back to unknown when commit hash / build date were not injected', () => {
        const info = getBuildInfo('0.71.2');
        expect(info.commitHash).toBe('unknown');
        expect(info.buildDate).toBe('unknown');
    });

    it('reports the build-time-injected commit hash and build date', () => {
        process.env.BUILD_COMMIT_HASH = 'abc1234';
        process.env.BUILD_DATE = '2026-08-01T00:00:00.000Z';
        const info = getBuildInfo('0.71.2');
        expect(info.commitHash).toBe('abc1234');
        expect(info.buildDate).toBe('2026-08-01T00:00:00.000Z');
    });

    it('flags a build as official only when OFFICIAL_BUILD is exactly "true"', () => {
        expect(getBuildInfo('0.71.2').isOfficialBuild).toBe(false);

        process.env.OFFICIAL_BUILD = 'true';
        expect(getBuildInfo('0.71.2').isOfficialBuild).toBe(true);

        process.env.OFFICIAL_BUILD = 'yes';
        expect(getBuildInfo('0.71.2').isOfficialBuild).toBe(false);
    });
});
