import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { ModelLauncherProfile } from './modelLauncherProfiles';

interface LauncherAuditPayload {
  schema_version?: number;
  requested?: { model?: string; provider?: string; task_sha256?: string };
  result?: {
    status?: string;
    raw_response?: string;
    raw_stdout?: string;
    error?: string | null;
  };
}

export interface ModelLauncherExecution {
  output: string;
  artifactPath: string;
}

export interface ModelLauncherAdapterDeps {
  pythonExecutable?: string;
  spawnProcess?: typeof spawn;
  readFile?: typeof fs.readFile;
  randomId?: () => string;
}

function safeAuditId(sessionId: string | undefined, randomId: () => string): string {
  const session = (sessionId || 'session').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  const suffix = randomId().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 36);
  return `nimbalyst-${session}-${suffix}`.slice(0, 120);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function invokeModelLauncher(input: {
  workspacePath: string;
  profile: ModelLauncherProfile;
  task: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  sessionId?: string;
  signal?: AbortSignal;
  deps?: ModelLauncherAdapterDeps;
}): Promise<ModelLauncherExecution> {
  const workspacePath = path.resolve(input.workspacePath);
  const launcherPath = path.resolve(workspacePath, 'tools', 'launcher', 'launcher.py');
  const auditDir = path.resolve(workspacePath, 'Temp', 'model-consultations');
  if (!isWithin(workspacePath, launcherPath) || !isWithin(workspacePath, auditDir)) {
    throw new Error('Unified Model Launcher paths escaped the active workspace.');
  }

  const readFile = input.deps?.readFile ?? fs.readFile;
  try {
    await readFile(launcherPath, 'utf8');
  } catch {
    throw new Error(
      `Unified Model Launcher is unavailable at ${launcherPath}. ` +
      'Open the workspace that owns tools/launcher/launcher.py.'
    );
  }

  const randomId = input.deps?.randomId ?? randomUUID;
  const auditId = safeAuditId(input.sessionId, randomId);
  const artifactPath = path.join(auditDir, `${auditId}.json`);
  const args = [
    launcherPath,
    'invoke',
    '--model', input.profile.launcherAlias,
    '--task-stdin',
    '--timeout', '600',
    '--audit-dir', auditDir,
    '--audit-id', auditId,
    ...(input.effort ? ['--effort', input.effort] : []),
  ];

  const spawnProcess = input.deps?.spawnProcess ?? spawn;
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(input.deps?.pythonExecutable ?? 'python', args, {
      cwd: workspacePath,
      windowsHide: true,
      // The validated audit is the response source of truth. Ignoring stdout
      // avoids a large model response filling an unread pipe and deadlocking.
      stdio: ['pipe', 'ignore', 'pipe'],
      signal: input.signal,
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unified Model Launcher exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin?.end(input.task, 'utf8');
  });

  let payload: LauncherAuditPayload;
  try {
    payload = JSON.parse(await readFile(artifactPath, 'utf8')) as LauncherAuditPayload;
  } catch (error) {
    throw new Error(`Unified Model Launcher did not produce a readable audit: ${String(error)}`);
  }

  if (payload.schema_version !== 1) {
    throw new Error('Unified Model Launcher audit has an unsupported schema version.');
  }
  if (payload.result?.status !== 'completed') {
    throw new Error(
      `Unified Model Launcher audit is ${payload.result?.status || 'invalid'}: ` +
      `${payload.result?.error || 'no completed response'}`
    );
  }
  const taskSha256 = createHash('sha256').update(input.task, 'utf8').digest('hex');
  if (payload.requested?.provider !== input.profile.approvedProvider
    || payload.requested?.model !== input.profile.resolvedModel
    || payload.requested?.task_sha256 !== taskSha256) {
    throw new Error('Unified Model Launcher audit does not match the approved route and task.');
  }
  const output = payload.result.raw_response ?? payload.result.raw_stdout;
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('Unified Model Launcher completed without response content.');
  }

  return { output: output.trim(), artifactPath };
}
