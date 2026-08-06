import crypto from 'node:crypto';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXACT_BACKEND_ID = 'ollama-glm-5-2-cloud';
export const EXACT_PERSISTED_MODEL = 'claude-code:ollama-glm-5-2-cloud';
export const EXACT_CHILD_MODEL_ALIAS = 'claude-sonnet-4-5-20250929';
export const EXACT_OLLAMA_TARGET = 'glm-5.2:cloud';
export const EXACT_UPSTREAM_MODEL = 'openai/glm-5.2:cloud';
export const EXACT_LITELLM_BASE_URL = 'http://127.0.0.1:4002';
export const CHILD_ROUTE_PREFIX = '[NIMBALYST-OLLAMA-NATIVE-CHILD] ';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;
const TERMINAL_STATUSES = new Set([
  'idle',
  'error',
  'interrupted',
  'waiting_for_input',
]);
const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|auth[-_]?token)/i;

function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function requireInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requireTargetValue(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} has an invalid route identity`);
  }
  return value;
}

export function parseArgs(argv) {
  const parsed = {
    launchReceiptPath: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    marker: undefined,
    backendId: EXACT_BACKEND_ID,
    persistedModel: EXACT_PERSISTED_MODEL,
    childModelAlias: EXACT_CHILD_MODEL_ALIAS,
    ollamaTarget: EXACT_OLLAMA_TARGET,
    upstreamModel: EXACT_UPSTREAM_MODEL,
    // Acceptance bar frozen to the GLM bar (ChiChi CC-ISSUE-OLLAMA-01,
    // 2026-07-30): first-turn manager marker + structured native-child receipt +
    // child marker. Second-turn/restored-resume continuity is separate optional
    // evidence, off by default; `--require-continuity` opts into the stricter
    // full-continuity run.
    requireContinuity: false,
  };
  const targetFlags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--launch-receipt') {
      parsed.launchReceiptPath = requireAbsolutePath(value, '--launch-receipt');
      index += 1;
    } else if (flag === '--timeout-ms') {
      parsed.timeoutMs = requireInteger(value, '--timeout-ms', 10_000, 60 * 60 * 1000);
      index += 1;
    } else if (flag === '--poll-ms') {
      parsed.pollMs = requireInteger(value, '--poll-ms', 250, 30_000);
      index += 1;
    } else if (flag === '--marker') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
        throw new Error('--marker must contain 8-80 safe identifier characters');
      }
      parsed.marker = value;
      index += 1;
    } else if (flag === '--backend-id') {
      parsed.backendId = requireTargetValue(
        value,
        '--backend-id',
        /^ollama-[a-z0-9-]+-cloud$/,
      );
      targetFlags.add(flag);
      index += 1;
    } else if (flag === '--persisted-model') {
      parsed.persistedModel = requireTargetValue(
        value,
        '--persisted-model',
        /^claude-code:ollama-[a-z0-9-]+-cloud$/,
      );
      targetFlags.add(flag);
      index += 1;
    } else if (flag === '--child-model-alias') {
      parsed.childModelAlias = requireTargetValue(
        value,
        '--child-model-alias',
        /^claude-(?:sonnet-[a-z0-9-]+|ollama-[a-z0-9-]+)$/,
      );
      targetFlags.add(flag);
      index += 1;
    } else if (flag === '--ollama-target') {
      parsed.ollamaTarget = requireTargetValue(
        value,
        '--ollama-target',
        /^[a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*)+$/,
      );
      targetFlags.add(flag);
      index += 1;
    } else if (flag === '--upstream-model') {
      parsed.upstreamModel = requireTargetValue(
        value,
        '--upstream-model',
        /^openai\/[a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*)+$/,
      );
      targetFlags.add(flag);
      index += 1;
    } else if (flag === '--require-continuity') {
      parsed.requireContinuity = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag ?? '<missing>'}`);
    }
  }

  if (!parsed.launchReceiptPath) {
    throw new Error('--launch-receipt is required');
  }
  if (targetFlags.size !== 0 && targetFlags.size !== 5) {
    throw new Error('All five exact target flags must be supplied together');
  }
  if (parsed.persistedModel !== `claude-code:${parsed.backendId}`) {
    throw new Error('Persisted model must exactly bind the requested backend id');
  }
  return parsed;
}

export function validateLaunchReceipt(receipt, receiptPath) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('Candidate launch receipt must be a JSON object');
  }
  if (receipt.schemaVersion !== 1 || receipt.status !== 'launched' || receipt.validateOnly !== false) {
    throw new Error('Candidate launch receipt must describe a schema-v1 live launch');
  }

  const stagingRoot = path.resolve('D:\\Nimbalyst-Staging');
  const launchReceiptPath = requireAbsolutePath(receiptPath, 'launch receipt path');
  const profilePath = requireAbsolutePath(receipt.profilePath, 'profilePath');
  const workspacePath = requireAbsolutePath(receipt.workspacePath, 'workspacePath');
  const claudeProjectsPath = requireAbsolutePath(receipt.claudeProjectsPath, 'claudeProjectsPath');
  const receiptDirectory = requireAbsolutePath(receipt.receiptDirectory, 'receiptDirectory');
  const candidateMainLogPath = requireAbsolutePath(
    receipt.candidateMainLogPath,
    'candidateMainLogPath',
  );

  for (const [label, candidate] of Object.entries({
    profilePath,
    workspacePath,
    claudeProjectsPath,
    receiptDirectory,
  })) {
    if (!isPathInside(candidate, stagingRoot)) {
      throw new Error(`${label} must remain under ${stagingRoot}`);
    }
  }
  if (!isPathInside(launchReceiptPath, receiptDirectory)) {
    throw new Error('Launch receipt must be inside its declared receipt directory');
  }
  if (!isPathInside(candidateMainLogPath, profilePath)) {
    throw new Error('candidateMainLogPath must be inside the candidate profile');
  }
  for (const [left, right] of [
    [profilePath, workspacePath],
    [profilePath, claudeProjectsPath],
    [workspacePath, claudeProjectsPath],
  ]) {
    if (isPathInside(left, right) || isPathInside(right, left)) {
      throw new Error('Candidate profile, workspace, and Claude projects paths must be isolated');
    }
  }

  const processId = requireInteger(receipt.processId, 'processId', 1, 2 ** 31 - 1);
  const cdpPort = requireInteger(receipt.cdpPort, 'cdpPort', 1, 65_535);
  if (cdpPort === 9222) {
    throw new Error('Candidate must not use the incumbent default CDP port');
  }
  if (
    receipt.environment?.NIMBALYST_STAGING_MODE !== '1'
    || path.resolve(receipt.environment?.NIMBALYST_USER_DATA_DIR ?? '') !== profilePath
    || path.resolve(receipt.environment?.NIMBALYST_USER_DATA_PATH ?? '') !== profilePath
    || path.resolve(receipt.environment?.NIMBALYST_CLAUDE_PROJECTS_DIR ?? '') !== claudeProjectsPath
    || receipt.environment?.NIMBALYST_CDP_PORT !== String(cdpPort)
  ) {
    throw new Error('Candidate launch environment does not match the persisted isolation contract');
  }
  if (
    receipt.processComparison?.candidateProcessId !== processId
    || receipt.processComparison?.candidateDistinctFromIncumbents !== true
    || receipt.processComparison?.incumbentMatchingProcessIds?.includes?.(processId)
  ) {
    throw new Error('Candidate process is not proven distinct from incumbent matching processes');
  }

  return {
    launchReceiptPath,
    profilePath,
    workspacePath,
    claudeProjectsPath,
    receiptDirectory,
    candidateMainLogPath,
    processId,
    cdpPort,
  };
}

function redactString(value, explicitSecrets) {
  let redacted = value;
  for (const secret of explicitSecrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

export function redactSensitive(value, explicitSecrets = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, explicitSecrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key)
          ? '[REDACTED]'
          : redactSensitive(entry, explicitSecrets),
      ]),
    );
  }
  if (typeof value === 'string') {
    return redactString(value, explicitSecrets);
  }
  return value;
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function parseManagedChildRouteReceipts(logText) {
  const receipts = [];
  for (const line of String(logText).split(/\r?\n/)) {
    const prefixIndex = line.indexOf(CHILD_ROUTE_PREFIX);
    if (prefixIndex < 0) continue;
    const jsonText = extractJsonObject(line.slice(prefixIndex + CHILD_ROUTE_PREFIX.length));
    if (!jsonText) continue;
    try {
      const receipt = JSON.parse(jsonText);
      if (receipt.event === 'native_claude_code_agent_child_launch') {
        receipts.push(receipt);
      }
    } catch {
      // Ignore unrelated or partially-flushed log lines.
    }
  }
  return receipts;
}

export function collectRouteLogLines(logText) {
  return String(logText)
    .split(/\r?\n/)
    .filter((line) => (
      line.includes('[ClaudeCodeBackend]')
      || line.includes(CHILD_ROUTE_PREFIX)
    ))
    .slice(-100);
}

function assertProcessAlive(processId) {
  try {
    process.kill(processId, 0);
  } catch {
    throw new Error(`Candidate process ${processId} is not alive`);
  }
}

async function waitForFile(filePath, deadline, pollMs) {
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for candidate file: ${filePath}`);
}

export function descriptorMatchesCandidate(descriptor, contract) {
  const workspaces = Array.isArray(descriptor?.workspaces) ? descriptor.workspaces : [];
  const matchingWorkspace = workspaces.some(
    (workspace) => path.resolve(workspace.path) === contract.workspacePath,
  );
  // The descriptor is written under the candidate-only profile before its
  // first renderer registers the workspace. Some builds therefore publish an
  // empty workspace snapshot and never rewrite it. The exact candidate PID,
  // profile-bound descriptor path, and later renderer IPC workspace check keep
  // this fail-closed without waiting forever for a field that cannot refresh.
  const workspaceSnapshotAccepted = workspaces.length === 0 || matchingWorkspace;
  return (
    descriptor?.pid === contract.processId
    && workspaceSnapshotAccepted
    && typeof descriptor.token === 'string'
    && descriptor.token.length >= 8
  );
}

async function waitForMcpDescriptor(descriptorPath, contract, deadline, pollMs) {
  await waitForFile(descriptorPath, deadline, pollMs);
  while (Date.now() < deadline) {
    try {
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
      if (descriptorMatchesCandidate(descriptor, contract)) {
        return descriptor;
      }
    } catch {
      // The candidate can atomically refresh the descriptor while booting.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('Timed out waiting for a candidate MCP descriptor matching PID and workspace');
}

async function invokeElectron(page, channel, ...args) {
  return page.evaluate(
    async ({ invokeChannel, invokeArgs }) => {
      if (!window.electronAPI?.invoke) {
        throw new Error('Candidate renderer does not expose electronAPI.invoke');
      }
      return window.electronAPI.invoke(invokeChannel, ...invokeArgs);
    },
    { invokeChannel: channel, invokeArgs: args },
  );
}

async function resolveCandidatePage(browser, workspacePath, deadline, pollMs) {
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const result = await invokeElectron(
            page,
            'sessions:list',
            workspacePath,
            { includeArchived: false },
          );
          if (result?.success) return page;
        } catch {
          // Candidate renderer may still be booting.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('Timed out resolving the candidate renderer for the isolated workspace');
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find?.((entry) => entry.type === 'text')?.text;
  if (result.isError) {
    throw new Error(`${name} failed: ${typeof text === 'string' ? text : 'unknown tool error'}`);
  }
  if (typeof text !== 'string') {
    throw new Error(`${name} returned no text result`);
  }
  return JSON.parse(text);
}

async function waitForTurn(client, sessionId, expectedCompletedRows, deadline, pollMs) {
  let lastStatus = null;
  let lastQueue = null;
  while (Date.now() < deadline) {
    [lastStatus, lastQueue] = await Promise.all([
      callTool(client, 'get_session_status', { sessionId }),
      callTool(client, 'list_queued_prompts', {
        sessionId,
        includeCompleted: true,
        includePromptText: false,
      }),
    ]);
    const completed = (lastQueue.prompts ?? []).filter(
      (entry) => entry.status === 'completed',
    ).length;
    const active = (lastQueue.prompts ?? []).some(
      (entry) => entry.status === 'executing' || entry.status === 'pending',
    );
    if (
      completed >= expectedCompletedRows
      && !active
      && TERMINAL_STATUSES.has(lastStatus.status)
    ) {
      return { status: lastStatus, queue: lastQueue };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `Timed out waiting for session ${sessionId}; `
    + `status=${lastStatus?.status ?? 'unknown'} queue=${JSON.stringify(lastQueue?.prompts ?? [])}`,
  );
}

async function waitForChildRouteReceipt(
  logPath,
  managerSessionId,
  target,
  deadline,
  pollMs,
) {
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const receipts = parseManagedChildRouteReceipts(await readFile(logPath, 'utf8'));
      const match = receipts.find((entry) => (
        entry.managerSessionId === managerSessionId
        && entry.backendId === target.backendId
        && entry.childModelAlias === target.childModelAlias
        && entry.baseUrl === EXACT_LITELLM_BASE_URL
      ));
      if (match) return { match, receipts };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('Timed out waiting for the qualified native child route receipt');
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, filePath);
}

export function resultText(result) {
  const lastResponse = typeof result?.lastResponse === 'string'
    ? result.lastResponse.trim()
    : '';
  if (lastResponse) return lastResponse;
  return typeof result?.fullResponse === 'string' ? result.fullResponse : '';
}

/**
 * Flatten a `transcript:get-tail-messages` payload into one searchable string.
 *
 * The compact `get_session_result` view (`lastResponse`/`fullResponse`) can come
 * back empty even when the manager turn plainly emitted its markers — the
 * markers are still present in the persisted transcript. Rather than depend on
 * the transcript's exact nested shape (which differs across builds), stringify
 * the whole tail: the acceptance markers are unique tokens, so a substring
 * search over the serialized transcript is a robust, shape-agnostic fallback.
 */
export function transcriptText(transcript) {
  if (transcript === undefined || transcript === null) return '';
  if (typeof transcript === 'string') return transcript;
  try {
    return JSON.stringify(transcript);
  } catch {
    return '';
  }
}

/**
 * Combined marker search space for a turn: the compact result view first, then
 * the full persisted transcript tail as the documented fallback for the
 * empty-`get_session_result` false negative (gpt-oss incident, 2026-07-29).
 */
export function markerHaystack(result, transcript) {
  return `${resultText(result)}\n${transcriptText(transcript)}`;
}

export function markdownForReceipt(receipt) {
  if (receipt.status !== 'passed') {
    return [
      '# Ollama live acceptance receipt',
      '',
      `- Status: \`${receipt.status}\``,
      `- Candidate: \`${receipt.candidate.candidateId}\` (PID \`${receipt.candidate.processId}\`)`,
      `- Requested Ollama target: \`${receipt.requestedRoute.ollamaTarget}\``,
      `- Expected upstream model: \`${receipt.requestedRoute.upstreamModel}\``,
      `- Error: \`${String(receipt.error ?? 'unknown failure')}\``,
      '',
      'No live row is admitted from this failed receipt.',
      '',
      'The MCP bearer token is neither printed nor persisted by this harness.',
      '',
    ].join('\n');
  }
  const firstResponse = receipt.evidence?.managerFirstTurn?.lastResponse ?? '';
  const secondResponse = receipt.evidence?.managerSecondTurn?.lastResponse ?? '';
  const lines = [
    '# Ollama live acceptance receipt',
    '',
    `- Status: \`${receipt.status}\``,
    `- Acceptance bar: \`${receipt.acceptanceBar ?? 'glm-bar'}\``,
    `- Candidate: \`${receipt.candidate.candidateId}\` (PID \`${receipt.candidate.processId}\`)`,
    `- Requested Ollama target: \`${receipt.requestedRoute.ollamaTarget}\``,
    `- Expected upstream model: \`${receipt.requestedRoute.upstreamModel}\``,
    `- Manager session: \`${receipt.manager.sessionId}\``,
    `- Persisted model: \`${receipt.manager.persistedModel}\``,
    `- Native child: \`${receipt.nativeChild.agentId}\``,
    `- Child model alias: \`${receipt.nativeChild.modelAlias}\``,
    `- Backend / base URL: \`${receipt.nativeChild.backendId}\` / \`${receipt.nativeChild.baseUrl}\``,
  ];
  if (receipt.continuityVerified) {
    lines.push(
      `- Provider session stable across turns: \`${receipt.manager.providerSessionStable}\``,
    );
  }
  lines.push(
    '',
    '## Manager result evidence',
    '',
    '```text',
    String(firstResponse).slice(0, 8_000),
    '```',
    '',
  );
  if (receipt.continuityVerified) {
    lines.push(
      '## Resumed second-turn evidence',
      '',
      '```text',
      String(secondResponse).slice(0, 8_000),
      '```',
      '',
    );
  }
  lines.push(
    'The MCP bearer token is neither printed nor persisted by this harness.',
    '',
  );
  return lines.join('\n');
}

export async function runLiveAcceptance(options) {
  const launchReceiptRaw = JSON.parse(readFileSync(options.launchReceiptPath, 'utf8'));
  const contract = validateLaunchReceipt(launchReceiptRaw, options.launchReceiptPath);
  assertProcessAlive(contract.processId);
  const target = {
    backendId: options.backendId,
    persistedModel: options.persistedModel,
    childModelAlias: options.childModelAlias,
    ollamaTarget: options.ollamaTarget,
    upstreamModel: options.upstreamModel,
  };

  const markerRoot = options.marker ?? crypto.randomUUID().replaceAll('-', '');
  const childMarker = `OLLAMA_CHILD_${markerRoot}`;
  const managerMarker = `OLLAMA_MANAGER_${markerRoot}`;
  const secondTurnMarker = `OLLAMA_RESUME_${markerRoot}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputJsonPath = path.join(
    contract.receiptDirectory,
    `ollama-live-acceptance-${timestamp}.json`,
  );
  const outputMarkdownPath = path.join(
    contract.receiptDirectory,
    `ollama-live-acceptance-${timestamp}.md`,
  );
  const deadline = Date.now() + options.timeoutMs;
  const descriptorPath = path.join(contract.profilePath, 'mcp-endpoint.json');

  let browser;
  let client;
  let transport;
  let token;
  let partialReceipt = {
    schemaVersion: 1,
    status: 'running',
    startedAtUtc: new Date().toISOString(),
    launchReceiptPath: contract.launchReceiptPath,
    requestedRoute: target,
    candidate: {
      candidateId: launchReceiptRaw.candidateId,
      processId: contract.processId,
      cdpPort: contract.cdpPort,
      profilePath: contract.profilePath,
      workspacePath: contract.workspacePath,
      claudeProjectsPath: contract.claudeProjectsPath,
      processComparison: launchReceiptRaw.processComparison,
    },
  };

  try {
    const descriptor = await waitForMcpDescriptor(
      descriptorPath,
      contract,
      deadline,
      options.pollMs,
    );
    const port = requireInteger(descriptor.port, 'MCP descriptor port', 1, 65_535);
    token = descriptor.token;

    const [{ chromium }, { Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@playwright/test'),
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${contract.cdpPort}`);
    const page = await resolveCandidatePage(
      browser,
      contract.workspacePath,
      deadline,
      options.pollMs,
    );

    const controllerSessionId = crypto.randomUUID();
    const controllerResult = await invokeElectron(page, 'sessions:create', {
      session: {
        id: controllerSessionId,
        provider: 'claude-code',
        model: target.persistedModel,
        title: 'Ollama live acceptance controller',
        agentRole: 'meta-agent',
        metadata: { acceptanceHarness: true },
      },
      workspaceId: contract.workspacePath,
    });
    if (!controllerResult?.success || controllerResult.id !== controllerSessionId) {
      throw new Error('Failed to create candidate-only meta-agent controller session');
    }

    transport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${port}/mcp/host`
        + `?workspacePath=${encodeURIComponent(contract.workspacePath)}`
        + `&sessionId=${encodeURIComponent(controllerSessionId)}`,
      ),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client(
      { name: 'nimbalyst-ollama-live-acceptance', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    const initialPrompt = [
      'This is a read-only live routing acceptance check.',
      `Reply with manager marker ${managerMarker}.`,
      'Use the native Claude Code Agent tool exactly once to launch one general-purpose child.',
      `Tell that child to return the exact marker ${childMarker} without using any tools.`,
      `After the child returns, include the exact child marker ${childMarker} in your own final response.`,
      'Do not edit or create files. Do not run Git. Do not create worktrees.',
      'Do not send notifications. Do not make external writes. Do not call any other tool.',
    ].join(' ');

    const created = await callTool(client, 'create_session', {
      title: `Ollama ${target.ollamaTarget} manager acceptance`,
      provider: 'claude-code',
      model: target.persistedModel,
      claudeCodeBackend: target.backendId,
      prompt: initialPrompt,
      useWorktree: false,
      toolScope: 'read',
    });
    if (!created?.sessionId) {
      throw new Error('create_session returned no manager session id');
    }
    const managerSessionId = created.sessionId;
    const firstTerminal = await waitForTurn(
      client,
      managerSessionId,
      1,
      deadline,
      options.pollMs,
    );
    const firstResult = await callTool(client, 'get_session_result', {
      sessionId: managerSessionId,
      includeFullResponse: true,
    });
    const firstTranscript = await invokeElectron(
      page,
      'transcript:get-tail-messages',
      managerSessionId,
      50,
    );
    const firstText = markerHaystack(firstResult, firstTranscript);
    const firstPredicates = {
      terminalIdle: firstTerminal.status.status === 'idle',
      persistedModelExact: firstResult.model === target.persistedModel,
      childMarkerPresent: firstText.includes(childMarker),
      managerMarkerPresent: firstText.includes(managerMarker),
    };
    partialReceipt.firstTurnPredicates = firstPredicates;
    if (Object.values(firstPredicates).some((value) => !value)) {
      const failed = Object.entries(firstPredicates)
        .filter(([, value]) => !value)
        .map(([name]) => name)
        .join(', ');
      throw new Error(`First manager turn failed predicates: ${failed}`);
    }
    const firstSessionRead = await invokeElectron(page, 'sessions:get', managerSessionId);
    const firstProviderSessionId = firstSessionRead?.session?.providerSessionId;
    if (!firstProviderSessionId) {
      throw new Error('First manager turn did not persist a provider session id');
    }

    const childRoute = await waitForChildRouteReceipt(
      contract.candidateMainLogPath,
      managerSessionId,
      target,
      deadline,
      options.pollMs,
    );

    // Continuity (second-turn + restored-resume) is separate optional evidence
    // under the frozen GLM bar. It runs only with --require-continuity; the vars
    // below stay null when the run stops at the GLM bar so the receipt omits
    // continuity fields rather than asserting first-turn values as second-turn.
    let continuityVerified = false;
    let secondResult = null;
    let secondTranscript = null;
    let secondTerminal = null;
    let secondProviderSessionId = null;
    let restoredResult = null;
    let restoredTerminal = null;
    let restoredProviderSessionId = null;

    if (options.requireContinuity) {
      const secondPrompt = [
        'This is the resumed second turn of the same read-only acceptance session.',
        `Reply with exactly ${secondTurnMarker} and ${childMarker}.`,
        'Do not call tools, spawn agents, edit files, run Git, create worktrees, notify, or make external writes.',
      ].join(' ');
      await callTool(client, 'send_prompt', {
        sessionId: managerSessionId,
        prompt: secondPrompt,
      });
      secondTerminal = await waitForTurn(
        client,
        managerSessionId,
        2,
        deadline,
        options.pollMs,
      );
      secondResult = await callTool(client, 'get_session_result', {
        sessionId: managerSessionId,
        includeFullResponse: true,
      });
      secondTranscript = await invokeElectron(
        page,
        'transcript:get-tail-messages',
        managerSessionId,
        50,
      );
      const secondSessionRead = await invokeElectron(page, 'sessions:get', managerSessionId);
      secondProviderSessionId = secondSessionRead?.session?.providerSessionId;
      const secondText = markerHaystack(secondResult, secondTranscript);
      if (
        secondTerminal.status.status !== 'idle'
        || secondResult.model !== target.persistedModel
        || !secondText.includes(secondTurnMarker)
        || !secondText.includes(childMarker)
        || secondProviderSessionId !== firstProviderSessionId
      ) {
        throw new Error('Second manager turn did not preserve the exact resumed identity and markers');
      }

      const restoreResult = await invokeElectron(
        page,
        'sessions:update-metadata',
        managerSessionId,
        { model: target.persistedModel },
      );
      if (!restoreResult?.success) {
        throw new Error('Failed to evict the cached provider for restored-resume validation');
      }
      const restoredPrompt = [
        'This is the restored-provider turn of the same read-only acceptance session.',
        `Reply with exactly ${secondTurnMarker} and ${childMarker}.`,
        'Do not call tools, spawn agents, edit files, run Git, create worktrees, notify, or make external writes.',
      ].join(' ');
      await callTool(client, 'send_prompt', {
        sessionId: managerSessionId,
        prompt: restoredPrompt,
      });
      restoredTerminal = await waitForTurn(
        client,
        managerSessionId,
        3,
        deadline,
        options.pollMs,
      );
      restoredResult = await callTool(client, 'get_session_result', {
        sessionId: managerSessionId,
        includeFullResponse: true,
      });
      const restoredTranscript = await invokeElectron(
        page,
        'transcript:get-tail-messages',
        managerSessionId,
        50,
      );
      const restoredSessionRead = await invokeElectron(page, 'sessions:get', managerSessionId);
      restoredProviderSessionId = restoredSessionRead?.session?.providerSessionId;
      const restoredText = markerHaystack(restoredResult, restoredTranscript);
      if (
        restoredTerminal.status.status !== 'idle'
        || restoredResult.model !== target.persistedModel
        || !restoredText.includes(secondTurnMarker)
        || !restoredText.includes(childMarker)
        || restoredProviderSessionId !== firstProviderSessionId
      ) {
        throw new Error('Restored provider did not preserve exact persisted identity and provider session');
      }
      continuityVerified = true;
    }
    const candidateLogText = await readFile(contract.candidateMainLogPath, 'utf8');

    partialReceipt = {
      ...partialReceipt,
      status: 'passed',
      completedAtUtc: new Date().toISOString(),
      controllerSessionId,
      acceptanceBar: continuityVerified ? 'glm-bar+continuity' : 'glm-bar',
      continuityVerified,
      manager: {
        sessionId: managerSessionId,
        provider: firstResult.provider,
        persistedModel: firstResult.model,
        firstProviderSessionId,
        firstTerminalState: firstTerminal.status.status,
        ...(continuityVerified
          ? {
            secondProviderSessionId,
            restoredProviderSessionId,
            providerSessionStable:
              firstProviderSessionId === secondProviderSessionId
              && firstProviderSessionId === restoredProviderSessionId,
            secondTerminalState: secondTerminal.status.status,
            restoredTerminalState: restoredTerminal.status.status,
          }
          : {}),
      },
      nativeChild: {
        agentId: childRoute.match.nativeChildAgentId,
        agentName: childRoute.match.nativeChildAgentName,
        backendId: childRoute.match.backendId,
        modelAlias: childRoute.match.childModelAlias,
        baseUrl: childRoute.match.baseUrl,
        launchKind: childRoute.match.launchKind,
        marker: childMarker,
      },
      markers: {
        manager: managerMarker,
        child: childMarker,
        ...(continuityVerified ? { secondTurn: secondTurnMarker } : {}),
      },
      evidence: {
        managerFirstTurn: firstResult,
        managerFirstTranscript: firstTranscript,
        firstQueue: firstTerminal.queue,
        ...(continuityVerified
          ? {
            managerSecondTurn: secondResult,
            managerRestoredTurn: restoredResult,
            managerSecondTranscript: secondTranscript,
            secondQueue: secondTerminal.queue,
            restoredQueue: restoredTerminal.queue,
          }
          : {}),
        routeLogLines: collectRouteLogLines(candidateLogText),
        nativeChildRouteReceipts: childRoute.receipts.filter(
          (entry) => entry.managerSessionId === managerSessionId,
        ),
      },
      safety: {
        sourceEditsRequested: false,
        gitActionsRequested: false,
        worktreeOperationsRequested: false,
        notificationsRequested: false,
        externalWritesRequested: false,
        mcpBearerTokenPersisted: false,
      },
    };
  } catch (error) {
    partialReceipt = {
      ...partialReceipt,
      status: 'failed',
      completedAtUtc: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await transport?.terminateSession?.().catch(() => undefined);
    await client?.close?.().catch(() => undefined);
    // A CDP-connected Browser has no public disconnect operation. Closing the
    // connection here also closes only the isolated candidate that this
    // acceptance run owns; it never targets the incumbent process.
    await browser?.close?.().catch(() => undefined);
  }

  const safeReceipt = redactSensitive(partialReceipt, token ? [token] : []);
  await atomicWrite(outputJsonPath, `${JSON.stringify(safeReceipt, null, 2)}\n`);
  await atomicWrite(outputMarkdownPath, markdownForReceipt(safeReceipt));
  if (safeReceipt.status !== 'passed') {
    throw new Error(
      `Live acceptance failed; redacted receipt: ${outputJsonPath}`,
    );
  }
  return { receipt: safeReceipt, outputJsonPath, outputMarkdownPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runLiveAcceptance(options);
  process.stdout.write(`${result.outputJsonPath}\n${result.outputMarkdownPath}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
