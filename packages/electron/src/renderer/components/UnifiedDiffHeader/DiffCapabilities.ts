/**
 * DiffCapabilities interface
 *
 * Defines the contract for what diff features an editor supports.
 * All editors must support accept/reject all. Granular change navigation
 * is optional and only supported by editors like Lexical.
 */

export interface ChangeGroupCapabilities {
  /** Total number of change groups */
  count: number;
  /** Currently selected change group index (0-based), or null if none selected */
  currentIndex: number | null;
  /** Navigate to previous change group */
  onNavigatePrevious: () => void;
  /** Navigate to next change group */
  onNavigateNext: () => void;
  /** Accept the currently selected change group (optional - not all editors support this) */
  onAcceptCurrent?: () => void;
  /** Reject the currently selected change group (optional - not all editors support this) */
  onRejectCurrent?: () => void;
  /** Whether per-change accept/reject is supported (default: true if onAcceptCurrent/onRejectCurrent provided) */
  supportsPerChangeActions?: boolean;
}

export interface DiffCapabilities {
  /** Accept all changes - required for all editors */
  onAcceptAll: () => void;
  /** Reject all changes - required for all editors */
  onRejectAll: () => void;
  /** Optional granular change navigation (Lexical supports this) */
  changeGroups?: ChangeGroupCapabilities;
}

export interface SessionInfo {
  /** Session ID for navigation */
  sessionId: string;
  /** Display title for the session */
  sessionTitle?: string;
  /** Timestamp when the edit was made */
  editedAt?: number;
  /** AI provider (e.g., 'claude-code', 'anthropic', 'openai') for icon display */
  provider?: string;
}

export interface UnifiedDiffHeaderProps {
  /** File path being edited */
  filePath: string;
  /** File name for display */
  fileName: string;
  /** Session information (for AI-generated changes) */
  sessionInfo?: SessionInfo;
  /** Callback when "Go to Session" is clicked */
  onGoToSession?: (sessionId: string) => void;
  /** Diff capabilities from the editor */
  capabilities: DiffCapabilities;
  /** Editor type for analytics */
  editorType: 'monaco' | 'lexical' | 'custom';
}
