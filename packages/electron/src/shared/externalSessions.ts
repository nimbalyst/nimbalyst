/** The main process resolves identities to source files; callers never supply log paths. */
export type ExternalSessionProviderId = "claude-code" | "openai-codex";
export interface ExternalSessionSelection {
  providerId: ExternalSessionProviderId;
  sessionId: string;
  workspacePath: string;
}
export interface ExternalSessionSummary extends ExternalSessionSelection {
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number | null;
  tokenUsage: unknown;
  syncStatus: "new" | "up-to-date" | "needs-update";
}
export interface ExternalSessionSyncResult extends ExternalSessionSelection {
  success: boolean;
  messagesAdded: number;
  error?: string;
}
export interface ExternalSessionScanResponse {
  success: boolean;
  sessions: ExternalSessionSummary[];
  error?: string;
}
export interface ExternalSessionSyncResponse {
  success: boolean;
  results: ExternalSessionSyncResult[];
  successCount: number;
  failureCount: number;
  error?: string;
}
