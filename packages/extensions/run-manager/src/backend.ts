/**
 * Run Manager backend module. Runs in an Electron utility process, once per
 * open project, while Developer Mode is on (`requiresDeveloperMode`).
 *
 * It reads the project's run targets from `.nimbalyst/run.json`, starts each
 * one as a command terminal through `ctx.services.terminals`, and registers
 * the agent tools plus the panel-only tools the Runs panel calls. Nothing
 * starts on its own. The host stops every terminal this module created when
 * the module stops (extension disabled, project closed, app quit).
 */
import { existsSync, unwatchFile, watchFile } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BackendMcpToolDefinition,
  BackendPanelsService,
  BackendTerminalsService,
} from '@nimbalyst/extension-sdk';
import { RUNS_PANEL_ID, RUN_CONFIG_PATH, runsBadge, type RunsBadge } from './shared/types';
import { findListenerPid, isPortOpen, stopExternalProcess } from './backend/probes';
import { RunManager } from './backend/runManager';
import {
  RUN_AGENT_TOOL_DESCRIPTORS,
  RUN_PANEL_TOOL_DESCRIPTORS,
  createRunToolHandlers,
} from './backend/runTools';
import { LOCKFILES, packageManagerFor } from './backend/suggestions';

/** How often the config file is checked for a change made outside this module. */
const CONFIG_WATCH_INTERVAL_MS = 1000;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Subset of the host's BackendActivateContext this module relies on. */
interface ActivateCtx {
  services: {
    workspacePath: string;
    log: (level: LogLevel, message: string, data?: unknown) => void;
    registerMcpTools: (tools: BackendMcpToolDefinition[]) => Promise<{ registered: string[] }>;
    /** `terminals`: command terminals owned by this extension. */
    terminals?: BackendTerminalsService;
    /** Gutter badge for the Runs panel button, settable while the panel is closed. */
    panels?: BackendPanelsService;
  };
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

export async function activate(ctx: ActivateCtx) {
  const { workspacePath, log, registerMcpTools, terminals, panels } = ctx.services;
  if (!terminals) {
    throw new Error('Run Manager needs the terminals permission (ctx.services.terminals is unavailable).');
  }
  const configFile = join(workspacePath, RUN_CONFIG_PATH);

  let tempCounter = 0;
  let lastBadge: RunsBadge | null = null;
  const publishBadge = () => {
    if (!panels) return;
    const next = runsBadge(manager.views());
    if (lastBadge && lastBadge.value === next.value && lastBadge.tone === next.tone) return;
    lastBadge = next;
    panels.setGutterBadge(RUNS_PANEL_ID, next.value, { tone: next.tone }).catch((error) => {
      lastBadge = null;
      log('warn', `[run] could not update the gutter badge: ${String(error)}`);
    });
  };

  const manager: RunManager = new RunManager({
    terminals,
    config: {
      read: () => readTextOrNull(configFile),
      write: async (text) => {
        // Write beside the file and rename over it, so a crash mid-write
        // cannot leave a truncated config.
        await mkdir(dirname(configFile), { recursive: true });
        const temp = `${configFile}.${process.pid}.${(tempCounter += 1)}.tmp`;
        try {
          await writeFile(temp, text, 'utf-8');
          await rename(temp, configFile);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
      },
    },
    readPackageInfo: async () => ({
      packageJson: await readTextOrNull(join(workspacePath, 'package.json')),
      packageManager: packageManagerFor(
        new Set(LOCKFILES.map(([file]) => file).filter((file) => existsSync(join(workspacePath, file))))
      ),
    }),
    isPortOpen,
    findListenerPid,
    stopExternalProcess: (pid, stillTarget) => stopExternalProcess(pid, { stillTarget }),
    log: (level, message) => log(level, message),
    onChange: publishBadge,
  });

  await manager.reloadConfig().catch((error) => log('error', `[run] could not read ${RUN_CONFIG_PATH}: ${String(error)}`));

  // Stat polling rather than fs.watch: the file, and the .nimbalyst folder,
  // may not exist yet, and editors replace the file on save.
  const onConfigChanged = () => {
    manager.reloadConfig().catch((error) => log('error', `[run] could not reload ${RUN_CONFIG_PATH}: ${String(error)}`));
  };
  watchFile(configFile, { interval: CONFIG_WATCH_INTERVAL_MS }, onConfigChanged);

  await registerMcpTools(
    [...RUN_AGENT_TOOL_DESCRIPTORS, ...RUN_PANEL_TOOL_DESCRIPTORS].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      scope: 'global' as const,
      ...(tool.panelOnly ? { panelOnly: true } : {}),
    }))
  );

  const handlers = createRunToolHandlers(manager);
  const panelOnly = new Set(RUN_PANEL_TOOL_DESCRIPTORS.map((tool) => tool.name));
  const methods: Record<string, (params: unknown, methodCtx: unknown) => Promise<unknown>> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    methods[name] = async (params, methodCtx) => {
      const caller = (methodCtx as { call?: { caller?: string } } | null)?.call?.caller;
      // The host already refuses agent calls to panel-only tools; this keeps it true if that ever regresses.
      if (panelOnly.has(name) && caller === 'agent') throw new Error(`${name} is only available to the Runs panel`);
      return handler((params && typeof params === 'object' ? params : {}) as Record<string, unknown>);
    };
  }

  log('info', `[run] ready for ${workspacePath}: ${manager.views().length} target(s)`);

  return {
    methods,
    deactivate: () => {
      unwatchFile(configFile, onConfigChanged);
      manager.dispose();
    },
  };
}
