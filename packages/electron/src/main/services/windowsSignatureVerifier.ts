import { execFile } from 'child_process';
import * as path from 'path';
import { parseDn } from 'builder-util-runtime';

/**
 * Replacement for electron-updater's Windows Authenticode check
 * (`windowsExecutableCodeSignatureVerifier.js`), which runs PowerShell
 * `Get-AuthenticodeSignature` under a hard-coded 20s `execFile` timeout.
 *
 * That is too short for a ~400MB installer that was just written to disk:
 * PowerShell cold start plus Defender scanning the new file routinely exceeds
 * it on ARM64, the child is killed, and the update aborts with a bare
 * "Command failed" error (NIM-7433). We keep the same command and the same
 * matching rules, raise the timeout, and retry once on timeout.
 *
 * Fail-closed: any non-timeout failure, stderr output, or a second timeout
 * rejects, and electron-updater refuses the update. A signature that is not
 * Valid or not from one of `publisherNames` resolves to a reason string,
 * which electron-updater also treats as a rejection. Only `null` means valid.
 */

export const SIGNATURE_CHECK_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 2;

export interface ExecResult {
  error: (Error & { killed?: boolean; signal?: NodeJS.Signals | null }) | null;
  stdout: string;
  stderr: string;
}

export type PowerShellExec = (command: string, timeoutMs: number) => Promise<ExecResult>;

interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export type VerifyUpdateCodeSignature = (
  publisherNames: string[],
  tempUpdateFile: string
) => Promise<string | null>;

function runPowerShell(command: string, timeoutMs: number): Promise<ExecResult> {
  // Same invocation as electron-updater: PSModulePath reset (electron-builder
  // #7127) and `&`-joined chcp so certificate subjects with non-ASCII
  // characters parse (electron-builder #8162).
  const executable = 'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe';
  const args = ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command];
  return new Promise((resolve) => {
    execFile(executable, args, { shell: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function isTimeout(error: ExecResult['error']): boolean {
  return error != null && error.killed === true;
}

function publisherMatches(publisherNames: string[], signerSubject: string): boolean {
  const subject = parseDn(signerSubject);
  return publisherNames.some((name) => {
    const dn = parseDn(name);
    if (dn.size) {
      return Array.from(dn.keys()).every((key) => dn.get(key) === subject.get(key));
    }
    return name === subject.get('CN');
  });
}

export function createWindowsSignatureVerifier(
  logger: Logger,
  exec: PowerShellExec = runPowerShell
): VerifyUpdateCodeSignature {
  return async (publisherNames, unescapedTempUpdateFile) => {
    // Single quotes are the only metacharacter inside a PowerShell
    // single-quoted string; doubling them prevents command injection via the
    // file name.
    const tempUpdateFile = unescapedTempUpdateFile.replace(/'/g, "''");
    const command = `"Get-AuthenticodeSignature -LiteralPath '${tempUpdateFile}' | ConvertTo-Json -Compress"`;

    let result: ExecResult | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      logger.info(`Verifying signature ${tempUpdateFile} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const startedAt = Date.now();
      result = await exec(command, SIGNATURE_CHECK_TIMEOUT_MS);
      if (!isTimeout(result.error)) break;
      logger.warn(
        `Signature check timed out after ${Date.now() - startedAt}ms (limit ${SIGNATURE_CHECK_TIMEOUT_MS}ms)`
      );
    }
    if (result == null) {
      throw new Error('Signature check did not run');
    }
    if (isTimeout(result.error)) {
      throw new Error(
        `Signature check timed out ${MAX_ATTEMPTS} times (${SIGNATURE_CHECK_TIMEOUT_MS}ms each); refusing update`
      );
    }
    if (result.error) {
      throw result.error;
    }
    if (result.stderr) {
      throw new Error(`Cannot execute Get-AuthenticodeSignature, stderr: ${result.stderr}`);
    }

    const data = JSON.parse(result.stdout) as {
      Status?: number;
      StatusMessage?: string;
      Path?: string;
      SignerCertificate?: { Subject?: string } | null;
    };

    if (data.Status !== 0) {
      return `Signature status ${data.Status}: ${data.StatusMessage ?? 'not valid'}`;
    }
    if (typeof data.Path === 'string' && path.normalize(data.Path) !== path.normalize(unescapedTempUpdateFile)) {
      return `Verified path ${data.Path} does not match update file ${unescapedTempUpdateFile}`;
    }
    const subject = data.SignerCertificate?.Subject;
    if (typeof subject !== 'string' || !publisherMatches(publisherNames, subject)) {
      const reason = `publisherNames: ${publisherNames.join(' | ')}, signer: ${subject ?? 'none'}`;
      logger.warn(`Sign verification failed, installer signed with incorrect certificate: ${reason}`);
      return reason;
    }
    return null;
  };
}
