/**
 * Crew backend module. Runs in an Electron utility process, activated once
 * per open workspace. It owns the crew's scheduler and shift runner
 * (CrewRuntime), and registers the crew's agent tools plus the panel-only
 * tools the Crew panel calls.
 *
 * Everything Crew stores is a file under nimbalyst-local/crew/ or metadata on
 * sessions the host created for it. The data dir holds the token usage ledger
 * and a cache of held wakes.
 */
import { mkdirSync } from 'node:fs';
import { CrewRuntime } from './backend/crewRuntime';
import { fileCache, ledgerFile } from './backend/crewDataFiles';
import { CrewService } from './backend/crewService';
import {
  CREW_AGENT_TOOL_DESCRIPTORS,
  CREW_PANEL_TOOL_DESCRIPTORS,
  createCrewToolHandlers,
} from './backend/crewTools';
import { BadgePublisher } from './backend/crewBadge';
import { crewGutterBadge } from './components/crewDeskModel';
import type { BackendMcpToolDefinition, BackendPanelsService, HostSessions, ToolCallContext } from './backend/hostSessions';

/** The manifest panel whose gutter button carries the crew badge. */
const CREW_PANEL_ID = 'crew';
/** Budgets age out and files change by hand without a runtime event; re-check this often. */
const BADGE_RECHECK_MS = 60_000;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Subset of the host's BackendActivateContext Crew relies on. */
interface ActivateCtx {
  services: {
    workspacePath: string;
    dataDir: string;
    log: (level: LogLevel, message: string, data?: unknown) => void;
    registerMcpTools: (tools: BackendMcpToolDefinition[]) => Promise<{ registered: string[] }>;
    /** `ai-sessions`: the host session API, scoped to this extension and workspace. */
    sessions?: HostSessions;
    /** Gutter badges for this extension's own panels, settable while the panel is closed. */
    panels?: BackendPanelsService;
  };
}

/** The host passes the tool caller's identity as `ctx.call`; absent for plain RPC calls. */
function readCallContext(methodCtx: unknown): ToolCallContext | undefined {
  if (!methodCtx || typeof methodCtx !== 'object') return undefined;
  return (methodCtx as { call?: ToolCallContext }).call;
}

export async function activate(ctx: ActivateCtx) {
  const { workspacePath, dataDir, log, registerMcpTools, sessions } = ctx.services;
  if (!sessions) {
    throw new Error('Crew needs the ai-sessions permission (ctx.services.sessions is unavailable).');
  }
  mkdirSync(dataDir, { recursive: true });

  const runtime = new CrewRuntime({ workspacePath, sessions, log, cache: fileCache(dataDir), ledger: ledgerFile(dataDir) });
  const service = new CrewService(runtime);
  const handlers = createCrewToolHandlers(runtime, service);

  await registerMcpTools(
    [...CREW_AGENT_TOOL_DESCRIPTORS, ...CREW_PANEL_TOOL_DESCRIPTORS].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      scope: 'global' as const,
      ...(tool.panelOnly ? { panelOnly: true } : {}),
      ...(tool.audience ? { audience: tool.audience } : {}),
    }))
  );

  // The gutter badge follows unread flags and budgets even while the panel is
  // closed. Same rule as the panel (crewGutterBadge); only sent when it changes.
  const { panels } = ctx.services;
  const badge = panels
    ? new BadgePublisher({
        compute: async () => crewGutterBadge(await service.roster()),
        send: (next) => panels.setGutterBadge(CREW_PANEL_ID, next.value, { tone: next.tone }),
        log: (message, data) => log('warn', `[crew] ${message}`, data),
      })
    : null;
  const badgeRecheck = badge ? setInterval(() => badge.request(), BADGE_RECHECK_MS) : null;
  if (badge) runtime.onChange(() => badge.request());

  // Start after registration so a shift's first turn can already see the tools.
  runtime.start()
    .then(() => badge?.publish())
    .catch((error) => log('error', `[crew] runtime failed to start: ${String(error)}`));

  const panelOnly = new Set(CREW_PANEL_TOOL_DESCRIPTORS.map((tool) => tool.name));
  const methods: Record<string, (params: unknown, methodCtx: unknown) => Promise<unknown>> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    methods[name] = async (params, methodCtx) => {
      const call = readCallContext(methodCtx);
      // The host already refuses agent calls to panel-only tools; this keeps it true if that ever regresses.
      if (panelOnly.has(name) && call?.caller === 'agent') throw new Error(`${name} is only available to the Crew panel`);
      return handler((params && typeof params === 'object' ? params : {}) as Record<string, unknown>, call);
    };
  }

  return {
    methods,
    deactivate: () => {
      if (badgeRecheck) clearInterval(badgeRecheck);
      badge?.stop();
      runtime.onChange(null);
      runtime.stop();
    },
  };
}
