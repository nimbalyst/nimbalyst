// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  createWindowsSignatureVerifier,
  SIGNATURE_CHECK_TIMEOUT_MS,
  type ExecResult,
} from '../windowsSignatureVerifier';

// NIM-7433: electron-updater's stock Authenticode check killed PowerShell at
// 20s, so a slow-but-valid check on a fresh 400MB installer aborted the update.

const FILE = 'C:\\Users\\me\\AppData\\Local\\@nimbalystelectron-updater\\pending\\temp-Nimbalyst-Windows-arm64.exe';
const PUBLISHER = 'NIMBALYST, INC.';
const logger = { info: vi.fn(), warn: vi.fn() };

const timedOut = (): ExecResult => ({
  error: Object.assign(new Error('Command failed: powershell.exe ...'), { killed: true, signal: 'SIGTERM' as const }),
  stdout: '',
  stderr: '',
});

const signed = (subject: string, status = 0): ExecResult => ({
  error: null,
  stdout: JSON.stringify({ Status: status, Path: FILE, SignerCertificate: { Subject: subject } }),
  stderr: '',
});

describe('createWindowsSignatureVerifier', () => {
  it('retries once after a timeout and accepts a valid signature', async () => {
    const exec = vi.fn().mockResolvedValueOnce(timedOut()).mockResolvedValueOnce(signed(`CN="${PUBLISHER}", O="${PUBLISHER}", C=US`));
    const verify = createWindowsSignatureVerifier(logger, exec);

    await expect(verify([PUBLISHER], FILE)).resolves.toBeNull();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][1]).toBe(SIGNATURE_CHECK_TIMEOUT_MS);
    expect(SIGNATURE_CHECK_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it('stays fail-closed: repeated timeouts reject, wrong signer or bad status returns a reason', async () => {
    const twoTimeouts = vi.fn().mockResolvedValue(timedOut());
    await expect(createWindowsSignatureVerifier(logger, twoTimeouts)([PUBLISHER], FILE)).rejects.toThrow(/timed out 2 times/);
    expect(twoTimeouts).toHaveBeenCalledTimes(2);

    const wrongSigner = vi.fn().mockResolvedValue(signed('CN=Evil Corp, O=Evil Corp, C=US'));
    await expect(createWindowsSignatureVerifier(logger, wrongSigner)([PUBLISHER], FILE)).resolves.toMatch(/Evil Corp/);

    const notValid = vi.fn().mockResolvedValue(signed(`CN="${PUBLISHER}"`, 2));
    await expect(createWindowsSignatureVerifier(logger, notValid)([PUBLISHER], FILE)).resolves.toMatch(/status 2/);
  });
});
