#!/usr/bin/env node
/**
 * Claude Code `PreToolUse` hook for the genuine `claude-code-cli` path
 * (NIM-806 Phase 4, Direction A — the interactive-mode-compatible mechanism).
 *
 * `--permission-prompt-tool` is silently ignored by the interactive CLI (verified
 * live, 2.1.168 — the native TUI prompt still showed). A `PreToolUse` hook,
 * however, IS honored interactively: returning `permissionDecision: "allow"|"deny"`
 * suppresses the native prompt (only `defer` is print-mode-only). So Nimbalyst
 * registers this hook via `--settings` and routes the decision to a GUI widget.
 *
 * Flow: the CLI runs this command before a matched tool (Bash/Edit/Write/…),
 * passing the tool call as JSON on stdin. We POST it to Nimbalyst's local
 * `/permission` endpoint (same loopback server + bearer as the MCP server), which
 * renders the ToolPermission widget and blocks until the user answers, then
 * returns `{decision}`. We translate that to the hook's permission contract.
 *
 * Zero dependencies (CommonJS, plain `http`) so it runs under any Node-compatible
 * runtime, including Electron-as-Node (`ELECTRON_RUN_AS_NODE=1 <electron> <this>`).
 *
 * FAIL-SAFE: on ANY error (no endpoint, bad response, timeout) we emit
 * `permissionDecision: "ask"` and exit 0 — the CLI then falls back to its native
 * prompt. We never hard-block the user and never exit non-zero (a non-zero exit
 * is itself a blocking signal to the CLI).
 */

'use strict';

const http = require('http');
const https = require('https');

const ENDPOINT = process.env.NIMBALYST_PERMISSION_URL || '';
const TOKEN = process.env.NIMBALYST_PERMISSION_TOKEN || '';
const WORKSPACE_PATH = process.env.NIMBALYST_WORKSPACE_PATH || '';
// Stay just under the CLI's hook timeout so we lose the race to the CLI, not the
// other way around (a clean "ask" fallback beats an ambiguous kill).
const REQUEST_TIMEOUT_MS = Number(process.env.NIMBALYST_PERMISSION_TIMEOUT_MS || 590000);

/** Emit the hook decision and exit. `reason` is optional, shown by the CLI. */
function emit(decision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision, // 'allow' | 'deny' | 'ask'
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
  try {
    process.stdout.write(JSON.stringify(out));
  } catch {
    // ignore
  }
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // Guard against a stdin that never closes.
    setTimeout(() => resolve(data), 5000);
  });
}

function postPermission(payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(ENDPOINT);
    } catch (e) {
      reject(new Error('bad endpoint url'));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
      },
      (res) => {
        let resBody = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          resBody += c;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(resBody));
            } catch (e) {
              reject(new Error('bad response json'));
            }
          } else {
            reject(new Error(`status ${res.statusCode}`));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('request timeout'));
    });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

(async () => {
  if (!ENDPOINT) {
    emit('ask', 'Nimbalyst permission endpoint not configured');
    return;
  }
  let input = {};
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    emit('ask', 'Could not parse hook input');
    return;
  }

  // Claude Code PreToolUse stdin (snake_case): session_id, tool_name, tool_input, cwd.
  const payload = {
    sessionId: input.session_id || input.sessionId || '',
    toolName: input.tool_name || input.toolName || '',
    toolInput: input.tool_input || input.toolInput || {},
    workspacePath: WORKSPACE_PATH,
    cwd: input.cwd || '',
  };

  if (!payload.sessionId || !payload.toolName) {
    emit('ask', 'Missing session or tool in hook input');
    return;
  }

  try {
    const result = await postPermission(payload);
    const decision = result && result.decision === 'allow' ? 'allow' : result && result.decision === 'deny' ? 'deny' : 'ask';
    emit(decision, result && result.reason ? String(result.reason) : undefined);
  } catch (e) {
    // Endpoint unreachable / errored → defer to the CLI's native prompt.
    emit('ask', `Nimbalyst permission unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
})();
