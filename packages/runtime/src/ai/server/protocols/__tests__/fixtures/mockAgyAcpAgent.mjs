#!/usr/bin/env node

/**
 * Mock ACP agent modeling the Antigravity CLI (`agy acp`) wire behavior for
 * CodexACPProtocol and GeminiAntigravityProvider tests.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

const auditPath = process.env.AGY_ACP_TEST_AUDIT_PATH;
const cliLogFlagIndex = process.argv.indexOf('--cli_log_file');
const cliLogFilePath = cliLogFlagIndex >= 0 ? process.argv[cliLogFlagIndex + 1] : undefined;
const testHttpsPort = process.env.AGY_ACP_TEST_HTTPS_PORT;

function writeCliLogLine(line) {
  if (!cliLogFilePath) return;
  fs.appendFileSync(cliLogFilePath, `${line}\n`, 'utf8');
}

function audit(method, params) {
  if (!auditPath) return;
  fs.appendFileSync(auditPath, `${JSON.stringify({ method, params })}\n`, 'utf8');
}

audit('process:env', {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
});

const MODEL_THOUGHT_LEVELS = {
  'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-pro-orchestrator-neon': [],
};

function buildConfigOptions(session) {
  const levels = MODEL_THOUGHT_LEVELS[session.model] ?? [];
  const options = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: session.model,
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      ],
    },
  ];
  if (levels.length > 0) {
    options.push({
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: session.thoughtLevel,
      options: levels.map((v) => ({ value: v, name: v })),
    });
  }
  options.push({
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: session.mode,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ],
  });
  return options;
}

class MockAgyAcpAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      agentInfo: { name: 'Mock Antigravity ACP Server', version: '1.5.14' },
    };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    const sessionId = randomUUID();
    const session = {
      cwd: params.cwd,
      model: 'gemini-4-neon',
      thoughtLevel: 'high',
      mode: 'default',
    };
    this.sessions.set(sessionId, session);
    if (testHttpsPort) {
      writeCliLogLine(
        `I1123 15:00:00.000000      70 server.go:1305] Language server listening on random port at ${testHttpsPort} for HTTPS (gRPC)`,
      );
      writeCliLogLine(
        `I1123 15:00:00.000000      70 server.go:1313] Language server listening on random port at ${Number(testHttpsPort) + 1} for HTTP`,
      );
    }
    audit('session/new', { cwd: params.cwd, mcpCount: params.mcpServers?.length ?? 0 });
    return {
      sessionId,
      models: {
        currentModelId: 'gemini-4-neon-high',
        availableModels: [
          { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
          { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
          { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
          { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
          { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
          { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
          { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
          { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
          { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
          { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
          { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
        ],
      },
      configOptions: buildConfigOptions(session),
    };
  }

  async loadSession(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    audit('session/load', { sessionId: params.sessionId });
    return {
      configOptions: buildConfigOptions(session),
    };
  }

  async setSessionMode(params) {
    const session = this.sessions.get(params.sessionId);
    if (session) session.mode = params.modeId;
    audit('session/set_mode', params);
    return {};
  }

  async setSessionConfigOption(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    audit('session/set_config_option', { configId: params.configId, value: params.value });
    if (params.configId === 'mode') {
      if (!['default', 'accept-edits', 'auto', 'plan'].includes(params.value)) {
        throw new Error(`Unknown mode: ${params.value}`);
      }
      session.mode = params.value;
    } else if (params.configId === 'model') {
      if (!(params.value in MODEL_THOUGHT_LEVELS)) {
        throw new Error(`Unknown model: ${params.value}`);
      }
      session.model = params.value;
      const levels = MODEL_THOUGHT_LEVELS[session.model];
      if (levels.length > 0 && !levels.includes(session.thoughtLevel)) {
        session.thoughtLevel = levels[levels.length - 1];
      }
    } else if (params.configId === 'thought_level') {
      const levels = MODEL_THOUGHT_LEVELS[session.model] ?? [];
      if (!levels.includes(params.value)) {
        throw new Error(`Thinking level "${params.value}" is not offered for model "${session.model}"`);
      }
      session.thoughtLevel = params.value;
    }
    return { configOptions: buildConfigOptions(session) };
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    const textBlock = params.prompt?.find((b) => b.type === 'text');
    const promptText = textBlock?.text ?? '';
    audit('session/prompt', {
      sessionId: params.sessionId,
      model: session.model,
      thoughtLevel: session.thoughtLevel,
      mode: session.mode,
      prompt: promptText,
    });

    if (promptText.includes('TRIGGER_AUTH_ERROR')) {
      throw new Error('User is not authenticated. Please log in.');
    }

    // Stream two thought chunks to verify coalescing into a single collapsed thinking block.
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'First I will search ' },
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'for the answer.' },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'search-1',
        name: 'search_web',
        title: '"latest node lts" on Web',
        kind: 'search',
        status: 'in_progress',
        rawInput: { query: 'latest node lts' },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'search-1',
        status: 'completed',
        rawOutput: { summary: 'Node.js 24 LTS' },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: 12500,
        size: 1048576,
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Answer from ${session.model} (${session.thoughtLevel}): ` },
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Node.js 24 LTS.' },
      },
    });

    return {
      stopReason: 'end_turn',
      usage: {
        inputTokens: 12000,
        outputTokens: 500,
        cachedReadTokens: 1000,
        cachedWriteTokens: 0,
        totalTokens: 12500,
      },
    };
  }

  async cancel() {
    return;
  }
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection((connection) => new MockAgyAcpAgent(connection), stream);
