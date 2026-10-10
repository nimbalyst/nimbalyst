/**
 * The host session API Crew runs on (`ctx.services.sessions`, permission
 * `ai-sessions`) and the tool call context (`ctx.call`).
 *
 * Type-only import from the SDK source: the published `dist` types trail the
 * source while the API is new. Switch to `@nimbalyst/extension-sdk` once the
 * SDK build includes `backendSessions`. Nothing here exists at runtime.
 */
export type {
  BackendMcpToolDefinition,
  BackendSessionsService as HostSessions,
  BackendToolCallContext as ToolCallContext,
  CreateOwnedSessionOptions as CreateSessionInput,
  OwnedSessionSettleOutcome as SettledOutcome,
  OwnedSessionSettledEvent as SessionSettledEvent,
  OwnedSessionStatus,
  OwnedSessionSummary as OwnedSession,
  OwnedSessionUsage,
  OwnedUsageReport,
  SessionOwner as SessionOwnerRef,
} from '../../../../extension-sdk/src/types/backendSessions';
export type { BackendPanelsService } from '../../../../extension-sdk/src/types/backendPanels';
