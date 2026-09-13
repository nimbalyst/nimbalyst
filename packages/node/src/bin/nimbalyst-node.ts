#!/usr/bin/env node
/**
 * Two modes, one binary.
 *
 * One turn (the original, unchanged):
 *
 *   nimbalyst-node --config ./nimbalyst-node.config.json \
 *                  --workspace /path/to/repo \
 *                  --prompt "list the files in this directory"
 *
 * Long-running headless device:
 *
 *   nimbalyst-node serve --config ./nimbalyst-node.config.json
 *
 * `--config` is required in both and has no default. Everything the node needs
 * -- including any credentials -- comes from that file, never from the
 * environment: see `config.ts`.
 */

import * as path from 'node:path';
import { loadConfig } from '../config.js';
import { NimbalystNode } from '../NimbalystNode.js';
import { serve } from '../serve/startServe.js';

interface Args {
  config?: string;
  workspace?: string;
  prompt?: string;
  session?: string;
  json?: boolean;
  help?: boolean;
}

const USAGE = `nimbalyst-node --config <file> --workspace <dir> --prompt <text>
nimbalyst-node serve --config <file>

Run one turn:
  --config    <file>  Required. JSON config: databasePath and explicit trust.mode;
                      optional schemaDir, claudeCodePath, providerApiKeys, mcpServers.
  --workspace <dir>   Required. Workspace the agent runs in (the SDK's cwd).
  --prompt    <text>  Required. The user turn to run.
  --session   <id>    Optional. Continue an existing session instead of a new one.
  --json              Emit the result as JSON instead of streaming text.

Serve (long-running headless device):
  --config    <file>  Required. Must additionally set "sync" and "workspacesPath".

  Joins the user's personal sync as a headless device, claims create-session
  requests targeted at sync.deviceId, checks out the mapped repo branch, runs
  turns and streams transcripts. SIGTERM exits 0; a revoked credential exits 3.
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--config': args.config = argv[++i]; break;
      case '--workspace': args.workspace = argv[++i]; break;
      case '--prompt': args.prompt = argv[++i]; break;
      case '--session': args.session = argv[++i]; break;
      case '--json': args.json = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/**
 * SIGTERM is how a container asks for a shutdown, and it is the ONLY expected
 * end to `serve`. It must exit 0 -- a supervisor reading a non-zero code
 * restarts the process it just deliberately stopped.
 */
async function runServe(configPath: string): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    const { exitCode } = await serve({ config: loadConfig(configPath), signal: controller.signal });
    return exitCode;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'serve') {
    const args = parseArgs(argv.slice(1));
    if (args.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (!args.config) {
      process.stderr.write(`missing required argument: --config\n\n${USAGE}`);
      return 2;
    }
    return runServe(args.config);
  }

  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const missing = (['config', 'workspace', 'prompt'] as const).filter((key) => !args[key]);
  if (missing.length > 0) {
    process.stderr.write(`missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}\n\n${USAGE}`);
    return 2;
  }

  const config = loadConfig(args.config!);
  const workspacePath = path.resolve(args.workspace!);

  const node = await NimbalystNode.open(config);
  try {
    const result = await node.runTurn({
      workspacePath,
      prompt: args.prompt!,
      sessionId: args.session,
      onChunk: args.json
        ? undefined
        : (chunk) => {
            if (chunk.type === 'text' && chunk.content) process.stdout.write(chunk.content);
            if (chunk.type === 'tool_call' && chunk.toolCall) {
              process.stdout.write(`\n[tool] ${chunk.toolCall.name}\n`);
            }
          },
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `\n\n--- session ${result.sessionId}: `
        + `${result.persistedMessageCount} message(s) persisted, `
        + `${result.toolCalls.length} tool call(s) ---\n`,
      );
    }

    if (result.error) {
      process.stderr.write(`turn ended with an error: ${result.error}\n`);
      return 1;
    }
    return 0;
  } finally {
    node.close();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
