import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  CHILD_ROUTE_PREFIX,
  collectRouteLogLines,
  descriptorMatchesCandidate,
  markdownForReceipt,
  markerHaystack,
  parseArgs,
  parseManagedChildRouteReceipts,
  redactSensitive,
  resultText,
  transcriptText,
  validateLaunchReceipt,
} from '../staging/run-ollama-live-acceptance.mjs';

function validLaunchReceipt(overrides = {}) {
  const profilePath = 'D:\\Nimbalyst-Staging\\candidates\\route-test\\user-data';
  const workspacePath = 'D:\\Nimbalyst-Staging\\candidates\\route-test\\workspace';
  const claudeProjectsPath = 'D:\\Nimbalyst-Staging\\candidates\\route-test\\claude-projects';
  const receiptDirectory = 'D:\\Nimbalyst-Staging\\candidates\\route-test\\receipts';
  return {
    schemaVersion: 1,
    status: 'launched',
    validateOnly: false,
    processId: 4242,
    profilePath,
    workspacePath,
    claudeProjectsPath,
    receiptDirectory,
    candidateMainLogPath: path.join(profilePath, 'logs', 'main.log'),
    cdpPort: 19441,
    environment: {
      NIMBALYST_STAGING_MODE: '1',
      NIMBALYST_USER_DATA_DIR: profilePath,
      NIMBALYST_USER_DATA_PATH: profilePath,
      NIMBALYST_CLAUDE_PROJECTS_DIR: claudeProjectsPath,
      NIMBALYST_CDP_PORT: '19441',
    },
    processComparison: {
      executableProcessName: 'Nimbalyst',
      incumbentMatchingProcessIds: [100, 200],
      candidateProcessId: 4242,
      candidateDistinctFromIncumbents: true,
    },
    ...overrides,
  };
}

test('parseArgs requires an absolute launch receipt and bounded timing values', () => {
  assert.throws(() => parseArgs([]), /required/);
  assert.throws(
    () => parseArgs(['--launch-receipt', 'relative.json']),
    /absolute path/,
  );
  assert.throws(
    () => parseArgs([
      '--launch-receipt',
      'D:\\Nimbalyst-Staging\\receipt.json',
      '--timeout-ms',
      '999',
    ]),
    /between 10000/,
  );
  assert.deepEqual(
    parseArgs([
      '--launch-receipt',
      'D:\\Nimbalyst-Staging\\receipt.json',
      '--timeout-ms',
      '60000',
      '--poll-ms',
      '500',
      '--marker',
      'route_test_1234',
    ]),
    {
      launchReceiptPath: 'D:\\Nimbalyst-Staging\\receipt.json',
      timeoutMs: 60000,
      pollMs: 500,
      marker: 'route_test_1234',
      backendId: 'ollama-glm-5-2-cloud',
      persistedModel: 'claude-code:ollama-glm-5-2-cloud',
      childModelAlias: 'claude-sonnet-4-5-20250929',
      ollamaTarget: 'glm-5.2:cloud',
      upstreamModel: 'openai/glm-5.2:cloud',
      requireContinuity: false,
    },
  );
});

test('parseArgs binds a complete non-default target and rejects partial identity overrides', () => {
  const launchArgs = [
    '--launch-receipt',
    'D:\\Nimbalyst-Staging\\receipt.json',
  ];
  assert.throws(
    () => parseArgs([...launchArgs, '--backend-id', 'ollama-gpt-oss-20b-cloud']),
    /All five exact target flags/,
  );
  assert.throws(
    () => parseArgs([
      ...launchArgs,
      '--backend-id',
      'ollama-gpt-oss-20b-cloud',
      '--persisted-model',
      'claude-code:ollama-wrong-cloud',
      '--child-model-alias',
      'claude-ollama-gpt-oss-20b',
      '--ollama-target',
      'gpt-oss:20b-cloud',
      '--upstream-model',
      'openai/gpt-oss:20b-cloud',
    ]),
    /exactly bind/,
  );
  assert.deepEqual(
    parseArgs([
      ...launchArgs,
      '--backend-id',
      'ollama-gpt-oss-20b-cloud',
      '--persisted-model',
      'claude-code:ollama-gpt-oss-20b-cloud',
      '--child-model-alias',
      'claude-ollama-gpt-oss-20b',
      '--ollama-target',
      'gpt-oss:20b-cloud',
      '--upstream-model',
      'openai/gpt-oss:20b-cloud',
    ]),
    {
      launchReceiptPath: 'D:\\Nimbalyst-Staging\\receipt.json',
      timeoutMs: 20 * 60 * 1000,
      pollMs: 2_000,
      marker: undefined,
      backendId: 'ollama-gpt-oss-20b-cloud',
      persistedModel: 'claude-code:ollama-gpt-oss-20b-cloud',
      childModelAlias: 'claude-ollama-gpt-oss-20b',
      ollamaTarget: 'gpt-oss:20b-cloud',
      upstreamModel: 'openai/gpt-oss:20b-cloud',
      requireContinuity: false,
    },
  );
});

test('parseArgs opts into full continuity only with --require-continuity', () => {
  const base = ['--launch-receipt', 'D:\\Nimbalyst-Staging\\receipt.json'];
  assert.equal(parseArgs(base).requireContinuity, false);
  assert.equal(
    parseArgs([...base, '--require-continuity']).requireContinuity,
    true,
  );
});

test('transcriptText and markerHaystack recover markers from the transcript when the compact result is empty', () => {
  // The gpt-oss false negative: get_session_result returns empty, but the
  // persisted transcript carries both markers. The haystack must find them.
  assert.equal(transcriptText(null), '');
  assert.equal(transcriptText('OLLAMA_MANAGER_abc'), 'OLLAMA_MANAGER_abc');
  const transcript = [
    { role: 'assistant', content: 'OLLAMA_MANAGER_deadbeef and OLLAMA_CHILD_deadbeef' },
  ];
  assert.match(transcriptText(transcript), /OLLAMA_MANAGER_deadbeef/);
  const haystack = markerHaystack(
    { lastResponse: '', fullResponse: '' },
    transcript,
  );
  assert.equal(haystack.includes('OLLAMA_MANAGER_deadbeef'), true);
  assert.equal(haystack.includes('OLLAMA_CHILD_deadbeef'), true);
});

test('passed markdown omits continuity sections under the frozen GLM bar', () => {
  const glmBar = markdownForReceipt({
    status: 'passed',
    acceptanceBar: 'glm-bar',
    continuityVerified: false,
    requestedRoute: { ollamaTarget: 'glm-5.2:cloud', upstreamModel: 'openai/glm-5.2:cloud' },
    candidate: { candidateId: 'route-test', processId: 4242 },
    manager: { sessionId: 'm-1', persistedModel: 'claude-code:ollama-glm-5-2-cloud' },
    nativeChild: {
      agentId: 'child-1',
      modelAlias: 'claude-sonnet-4-5-20250929',
      backendId: 'ollama-glm-5-2-cloud',
      baseUrl: 'http://127.0.0.1:4002',
    },
    evidence: { managerFirstTurn: { lastResponse: 'OLLAMA_MANAGER_x OLLAMA_CHILD_x' } },
  });
  assert.match(glmBar, /Acceptance bar: `glm-bar`/);
  assert.equal(glmBar.includes('Resumed second-turn evidence'), false);
  assert.equal(glmBar.includes('Provider session stable'), false);
});

test('validateLaunchReceipt accepts only a distinct isolated live candidate', () => {
  const receiptPath = 'D:\\Nimbalyst-Staging\\candidates\\route-test\\receipts\\launched.json';
  const contract = validateLaunchReceipt(validLaunchReceipt(), receiptPath);
  assert.equal(contract.processId, 4242);
  assert.equal(contract.cdpPort, 19441);

  assert.throws(
    () => validateLaunchReceipt(validLaunchReceipt({ validateOnly: true }), receiptPath),
    /live launch/,
  );
  assert.throws(
    () => validateLaunchReceipt(validLaunchReceipt({ cdpPort: 9222 }), receiptPath),
    /default CDP port/,
  );
  assert.throws(
    () => validateLaunchReceipt(
      validLaunchReceipt({
        processComparison: {
          incumbentMatchingProcessIds: [4242],
          candidateProcessId: 4242,
          candidateDistinctFromIncumbents: false,
        },
      }),
      receiptPath,
    ),
    /distinct/,
  );
});

test('descriptor matching accepts the profile-bound startup snapshot but rejects ambiguity', () => {
  const contract = {
    processId: 4242,
    workspacePath: 'D:\\Nimbalyst-Staging\\candidates\\route-test\\workspace',
  };
  assert.equal(descriptorMatchesCandidate({
    pid: 4242,
    token: 'candidate-token',
    workspaces: [],
  }, contract), true);
  assert.equal(descriptorMatchesCandidate({
    pid: 4242,
    token: 'candidate-token',
    workspaces: [{ path: contract.workspacePath }],
  }, contract), true);
  assert.equal(descriptorMatchesCandidate({
    pid: 4242,
    token: 'candidate-token',
    workspaces: [{ path: 'D:\\other-workspace' }],
  }, contract), false);
  assert.equal(descriptorMatchesCandidate({
    pid: 9999,
    token: 'candidate-token',
    workspaces: [],
  }, contract), false);
});

test('failed receipt markdown remains file-backed without dereferencing success-only fields', () => {
  const markdown = markdownForReceipt({
    status: 'failed',
    error: 'descriptor mismatch',
    requestedRoute: {
      ollamaTarget: 'gpt-oss:20b-cloud',
      upstreamModel: 'openai/gpt-oss:20b-cloud',
    },
    candidate: {
      candidateId: 'route-test',
      processId: 4242,
    },
  });
  assert.match(markdown, /descriptor mismatch/);
  assert.match(markdown, /No live row is admitted/);
});

test('resultText falls back from an empty compact response to the full turn', () => {
  assert.equal(resultText({
    lastResponse: '',
    fullResponse: 'manager and child markers',
  }), 'manager and child markers');
  assert.equal(resultText({
    lastResponse: ' compact marker ',
    fullResponse: 'full marker',
  }), 'compact marker');
});

test('redactSensitive removes structured and embedded bearer secrets', () => {
  const token = 'candidate-token-123456';
  const redacted = redactSensitive({
    token,
    Authorization: `Bearer ${token}`,
    nested: {
      message: `request used Bearer ${token}`,
      safe: 'claude-code:ollama-glm-5-2-cloud',
    },
  }, [token]);
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.Authorization, '[REDACTED]');
  assert.equal(redacted.nested.message.includes(token), false);
  assert.equal(redacted.nested.safe, 'claude-code:ollama-glm-5-2-cloud');
});

test('parseManagedChildRouteReceipts extracts only structured native child evidence', () => {
  const receipt = {
    schemaVersion: 1,
    event: 'native_claude_code_agent_child_launch',
    managerSessionId: 'manager-1',
    backendId: 'ollama-glm-5-2-cloud',
    childModelAlias: 'claude-sonnet-4-5-20250929',
    baseUrl: 'http://127.0.0.1:4002',
    nativeChildAgentId: 'worker@route-team',
    nativeChildAgentName: 'worker',
    launchKind: 'spawn',
  };
  const logs = [
    'ordinary log line',
    `2026-07-29 INFO ${CHILD_ROUTE_PREFIX}${JSON.stringify(receipt)}`,
    `${CHILD_ROUTE_PREFIX}{not-json}`,
  ].join('\n');
  assert.deepEqual(parseManagedChildRouteReceipts(logs), [receipt]);
  assert.deepEqual(collectRouteLogLines(logs), [
    `2026-07-29 INFO ${CHILD_ROUTE_PREFIX}${JSON.stringify(receipt)}`,
    `${CHILD_ROUTE_PREFIX}{not-json}`,
  ]);
});
