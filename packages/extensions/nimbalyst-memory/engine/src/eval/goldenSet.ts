/**
 * The golden query set: questions a developer working in this repo would
 * actually ask, each paired with the source section that answers it.
 *
 * Two rules govern what belongs here, and both exist because it is easy to
 * build a golden set that measures nothing:
 *
 * 1. **The question is phrased the way someone would ask it**, not
 *    reverse-engineered from the target chunk's wording. A question assembled
 *    out of its answer's sentences is a lookup, not a retrieval test.
 * 2. **A meaningful share carry the `semantic` tag** — deliberately phrased
 *    without the target's vocabulary, so BM25 cannot reach them on term overlap
 *    alone. Without those, every arm scores the same and the instrument cannot
 *    tell an embedding upgrade from a regression.
 *
 * Targets are `path` + `heading`, matching how the chunker cites. `run.ts`
 * validates every one against the live index before scoring, so a heading that
 * gets renamed surfaces as an unresolved target rather than as a silent zero.
 */
import type { GoldenQuestion } from './types.js';

export const GOLDEN_SET: GoldenQuestion[] = [
  // --- .claude/rules ------------------------------------------------------
  {
    id: 'rules-parallel-disjoint',
    question: 'If I want two agents working on this repo at the same time, what do I have to check first?',
    expect: [{ path: '.claude/rules/parallel-sessions.md', heading: 'Parallel Sessions Must Not Share Files' }],
    tags: ['semantic'],
  },
  {
    id: 'rules-parallel-shared-files',
    question: 'Which files do parallel sessions collide on most often?',
    expect: [{ path: '.claude/rules/parallel-sessions.md', heading: 'The shared files everyone forgets' }],
  },
  {
    id: 'rules-changelog-timing',
    question: 'At what point in a task am I supposed to write the CHANGELOG entry?',
    expect: [
      { path: '.claude/rules/parallel-sessions.md', heading: 'Never edit CHANGELOG.md before a commit is requested' },
      { path: 'CLAUDE.md', heading: 'Keep Commit Messages and CHANGELOG Entries Short' },
    ],
  },
  {
    id: 'rules-who-runs-the-gate',
    question: 'When work is split across several sessions, who runs the full test gate?',
    expect: [{ path: '.claude/rules/parallel-sessions.md', heading: 'Orchestrator responsibilities' }],
    tags: ['semantic'],
  },
  {
    id: 'rules-dropdown-clipping',
    question: 'My dropdown gets cut off at the bottom of the window and inside scrolling containers. What should I use instead of computing coordinates by hand?',
    expect: [
      { path: '.claude/rules/floating-ui.md', heading: 'CRITICAL: Use @floating-ui/react for All Popover/Tooltip/Menu Positioning' },
      { path: 'CLAUDE.md', heading: 'Use @floating-ui/react for All Popover/Tooltip/Menu Positioning' },
    ],
    tags: ['semantic'],
  },
  {
    id: 'rules-destructive-requirements',
    question: 'What has to happen before code is allowed to rename or delete the user database?',
    expect: [{ path: '.claude/rules/destructive-data-paths.md', heading: 'Requirements for any destructive path' }],
  },
  {
    id: 'rules-untestable-branch',
    question: 'A branch only fires on a real WASM abort I cannot reproduce locally. How am I supposed to test it?',
    expect: [{ path: '.claude/rules/destructive-data-paths.md', heading: 'Extract the decision from the environment' }],
    tags: ['semantic'],
  },
  {
    id: 'rules-failing-test-first',
    question: 'Do I need a failing test before I fix a bug that can only be checked by restarting the app?',
    expect: [
      { path: '.claude/rules/end-to-end-verification.md', heading: 'End-to-End Verification Before Declaring Victory' },
      { path: 'CLAUDE.md', heading: 'End-to-End Verification Before Declaring Victory' },
    ],
  },
  {
    id: 'rules-test-cost',
    question: 'Why does everyone keep telling me to extend an existing test file instead of adding a new one?',
    expect: [
      { path: '.claude/rules/token-discipline.md', heading: 'Token Discipline' },
      { path: 'CLAUDE.md', heading: 'Write and Run Tests for Behavioral Changes' },
    ],
    tags: ['semantic'],
  },

  // --- CLAUDE.md ----------------------------------------------------------
  {
    id: 'claude-env-api-key',
    question: 'Can I fall back to reading the API key out of process.env if the user has not configured one?',
    expect: [{ path: 'CLAUDE.md', heading: 'Never Use Environment Variables as Implicit API Key Sources' }],
  },
  {
    id: 'claude-which-jwt',
    question: 'Which token authorizes joining a shared tracker room?',
    expect: [
      { path: 'CLAUDE.md', heading: 'Personal JWT vs Team JWT — Never Interchange Them' },
      { path: 'docs/IDENTITY_AUTH_AND_ROOMS.md', heading: '2. The two JWTs' },
    ],
    tags: ['semantic'],
  },
  {
    id: 'claude-db-direct-open',
    question: 'Is it safe to open the app database from a throwaway node script to check a row?',
    expect: [{ path: 'CLAUDE.md', heading: 'Database Access Rules' }],
  },
  {
    id: 'claude-nim-keys-in-source',
    question: 'Should I put a NIM-1234 reference in a code comment?',
    expect: [{ path: 'CLAUDE.md', heading: '`NIM-###` Keys Are Tracker-Scoped — Cite GitHub Issues in Source' }],
  },
  {
    id: 'claude-dynamic-import-main',
    question: 'Is it OK to turn a top-level import in the Electron main process into an await import()?',
    expect: [{ path: 'CLAUDE.md', heading: 'No Dynamic Imports in Electron Main Process' }],
  },
  {
    id: 'claude-d1-vs-do',
    question: 'On the collab server, what is allowed to go in the shared D1 database and what has to stay per-entity?',
    expect: [{ path: 'CLAUDE.md', heading: 'CollabV3 Data Isolation — DOs for Customer Data, D1 for Entity Management Only' }],
  },
  {
    id: 'claude-who-starts-dev',
    question: 'Should the agent start the dev server itself?',
    expect: [{ path: 'CLAUDE.md', heading: 'General Development Guidelines' }],
    tags: ['semantic'],
  },
  {
    id: 'claude-run-observations',
    question: 'The user asked me to debug a sync failure. Should I hand them a wrangler command to paste the output of?',
    expect: [
      { path: 'CLAUDE.md', heading: "Always Run Your Own Observation Commands — Don't Push Logs/Curl/Tail to the User" },
    ],
    tags: ['semantic'],
  },

  // --- docs/ --------------------------------------------------------------
  {
    id: 'docs-derived-atoms',
    question: 'Why does session state have to be a derived atom rather than its own independent atom?',
    expect: [{ path: 'docs/JOTAI.md', heading: 'Why Derived Atoms?' }],
  },
  {
    id: 'docs-component-ipc',
    question: 'What goes wrong if a React component calls electronAPI.on(...) in a useEffect?',
    expect: [
      { path: 'docs/JOTAI.md', heading: 'Anti-Pattern 3: Component-Level IPC Subscriptions' },
      { path: 'docs/IPC_LISTENERS.md', heading: 'Anti-Patterns' },
    ],
    tags: ['semantic'],
  },
  {
    id: 'docs-storage-backend-choice',
    question: 'I need to persist a setting that only applies to the currently open project. Where should it go?',
    expect: [{ path: 'docs/JOTAI.md', heading: 'When to Use Each Storage Backend' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-editor-owns-content',
    question: 'Should the tab component hold the text the user is typing, or should the editor?',
    expect: [{ path: 'docs/EDITOR_STATE.md', heading: '1. Editors Own Their Content State' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-stateful-editor-remount',
    question: 'Why does Monaco lose the cursor and undo history when its parent re-renders?',
    expect: [{ path: 'docs/EDITOR_STATE.md', heading: '4. Stateful Editors Cannot Be Re-Rendered' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-editorhost-contract',
    question: 'How does an extension editor communicate with the host app instead of through props?',
    expect: [
      { path: 'docs/EDITOR_STATE.md', heading: '3. Communication via EditorHost, Not Props' },
      { path: 'docs/EXTENSION_ARCHITECTURE.md', heading: 'EditorHost Contract' },
    ],
  },
  {
    id: 'docs-persisted-field-checklist',
    question: 'What do I need to do when I add a new field to state that gets saved to disk?',
    expect: [{ path: 'docs/STATE_PERSISTENCE.md', heading: 'Checklist When Adding New Persisted Fields' }],
  },
  {
    id: 'docs-undefined-on-load',
    question: 'A user updated and now the app crashes on startup reading a property of undefined. Why?',
    expect: [{ path: 'docs/STATE_PERSISTENCE.md', heading: 'The Problem' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-transcript-two-tier',
    question: 'Between the raw message log and the canonical events, which one is the source of truth?',
    expect: [{ path: 'docs/TRANSCRIPT_ARCHITECTURE.md', heading: 'Storage model' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-1m-context',
    question: 'Why does the context meter show a different total when running through the CLI?',
    expect: [{ path: 'docs/CONTEXT_WINDOW_USAGE_TRACKING.md', heading: 'The 1M Context Window (and why the CLI path differs)' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-compaction-usage',
    question: 'What happens to the reported token usage after the conversation gets compacted?',
    expect: [{ path: 'docs/CONTEXT_WINDOW_USAGE_TRACKING.md', heading: 'Compaction Handling' }],
  },
  {
    id: 'docs-worktree-is-workstream',
    question: 'If several sessions share a git worktree, how are they grouped in the left pane?',
    expect: [{ path: 'docs/SESSION_HIERARCHY.md', heading: 'A worktree IS the workstream' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-find-rerenders',
    question: 'The UI feels sluggish while an agent is streaming. How do I find out which component is redrawing constantly?',
    expect: [{ path: 'docs/RENDER_PERFORMANCE.md', heading: 'The instrument' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-render-budget-test',
    question: 'How do I stop a hot component from silently regressing back to too many renders?',
    expect: [{ path: 'docs/RENDER_PERFORMANCE.md', heading: 'Render budgets in tests' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-component-root-class',
    question: 'Tailwind utilities are all my component has on its root div. Is that enough?',
    expect: [{ path: 'docs/REACT_DOM_MARKERS.md', heading: '1. Give meaningful component roots a semantic class' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-member-id-per-org',
    question: 'Why does the same person have a different id depending on which organization they are in?',
    expect: [
      { path: 'docs/IDENTITY_AUTH_AND_ROOMS.md', heading: '1. Stytch org model' },
      { path: 'docs/IDENTITY_AUTH_AND_ROOMS.md', heading: '2. The two JWTs' },
    ],
    tags: ['semantic'],
  },
  {
    id: 'docs-room-taxonomy',
    question: 'What rooms exist on the sync server and what does each one carry?',
    expect: [{ path: 'docs/IDENTITY_AUTH_AND_ROOMS.md', heading: '4. Room taxonomy' }],
  },
  {
    id: 'docs-permission-modes',
    question: 'What are the different modes controlling whether an agent has to ask before running a command?',
    expect: [{ path: 'docs/AGENT_PERMISSIONS.md', heading: 'Permission Modes' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-codex-prompt-identity',
    question: 'Why do Codex prompts need their own correlation id?',
    expect: [{ path: 'docs/INTERACTIVE_PROMPTS.md', heading: 'Codex Prompt Identity' }],
  },
  {
    id: 'docs-fail-fast-params',
    question: 'An IPC handler was called without the project path. Should it log and carry on with a default?',
    expect: [{ path: 'docs/ERROR_HANDLING.md', heading: 'Rules' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-before-after-snapshot',
    question: 'How does the diff view know what a file looked like before the agent touched it?',
    expect: [{ path: 'docs/FILE_WATCHING_AND_CHANGE_TRACKING.md', heading: '2. Snapshot and Before/After State' }],
    tags: ['semantic'],
  },
  {
    id: 'docs-wire-casing',
    question: 'Should a WebSocket message field be spelled sync_request or syncRequest?',
    expect: [{ path: 'docs/NAMING_CONVENTIONS.md' }],
  },

  // --- design/ ------------------------------------------------------------
  {
    id: 'design-key-wrapping',
    question: 'When someone new is added to a shared document, how do they get the document key?',
    expect: [{ path: 'design/Collaboration/realtime-document-collaboration.md', heading: 'Key Exchange: ECDH + Key Wrapping' }],
    tags: ['semantic'],
  },
  {
    id: 'design-server-cannot-read',
    question: 'What exactly is the server assumed to be able to see, and what is it prevented from seeing?',
    expect: [{ path: 'design/Collaboration/realtime-document-collaboration.md', heading: 'Threat Model' }],
    tags: ['semantic'],
  },
  {
    id: 'design-ydoc-growth',
    question: 'A long-lived shared document accumulates update history forever. How is that bounded?',
    expect: [{ path: 'design/Collaboration/realtime-document-collaboration.md', heading: 'State Compaction' }],
    tags: ['semantic'],
  },
  {
    id: 'design-agent-protocol',
    question: 'What interface does a new AI provider have to implement to plug in?',
    expect: [{ path: 'design/agents/agent-provider-architecture.md', heading: '2. The `AgentProtocol` contract' }],
    tags: ['semantic'],
  },
  {
    id: 'design-provider-tool-calls',
    question: 'How does a provider report that the model wants to run a tool?',
    expect: [{ path: 'design/agents/agent-provider-architecture.md', heading: '6. Tool calling' }],
  },
  {
    id: 'design-new-provider-checklist',
    question: 'I am adding support for another coding agent. What is the list of things I have to cover?',
    expect: [{ path: 'design/agents/agent-provider-architecture.md', heading: '12. Checklist for a new agent provider' }],
    tags: ['semantic'],
  },
  {
    id: 'design-trackers-why-db',
    question: 'Why did trackers stop being plain YAML files on disk?',
    expect: [{ path: 'design/trackers/unified-tracker-system.md', heading: 'Problem' }],
    tags: ['semantic'],
  },
  {
    id: 'design-tracker-mcp-tools',
    question: 'What tracker operations are exposed to agents over MCP?',
    expect: [{ path: 'design/trackers/unified-tracker-system.md', heading: 'MCP Tools for AI Agents' }],
  },

  // --- nimbalyst-local/plans ---------------------------------------------
  {
    id: 'plans-memory-substrate',
    question: 'Why are mined memories going on the tracker substrate instead of getting their own sync engine and review queue?',
    expect: [
      { path: 'nimbalyst-local/plans/memory-v3-substrate-cli-and-review-ui.md', heading: 'The reframe: two classes, not one bucket' },
      { path: 'nimbalyst-local/plans/memory-v3-substrate-cli-and-review-ui.md', heading: 'Decision' },
    ],
  },
  {
    id: 'plans-jsonl-volatile',
    question: 'Which memory fields must never be written to the committed file, and why?',
    expect: [{ path: 'nimbalyst-local/plans/memory-v3-substrate-cli-and-review-ui.md', heading: 'Why memory JSONL is safer than issue JSONL' }],
    tags: ['semantic'],
  },
  {
    id: 'plans-jsonl-locations',
    question: 'Where does the personal memory replica live versus the one that gets checked in?',
    expect: [{ path: 'nimbalyst-local/plans/memory-v3-substrate-cli-and-review-ui.md', heading: 'Shape' }],
    tags: ['semantic'],
  },
  {
    id: 'plans-memory-no-key',
    question: 'What is blocking project memory from working for someone who has not entered an OpenAI key?',
    expect: [{ path: 'nimbalyst-local/plans/solo-no-account-gaps.md', heading: 'Track B — memory works without an OpenAI key' }],
  },
  {
    id: 'plans-availability-readiness',
    question: 'Why does the memory feature report itself as available when it cannot answer anything?',
    expect: [{ path: 'nimbalyst-local/plans/solo-no-account-gaps.md', heading: 'NIM-3669 — availability keyed on engine readiness (do this first)' }],
    tags: ['semantic'],
  },
  {
    id: 'plans-leaving-promise',
    question: 'If someone decides to stop using the app, how do they take their work with them?',
    expect: [{ path: 'nimbalyst-local/plans/solo-no-account-gaps.md', heading: 'Track A — the leaving promise' }],
    tags: ['semantic'],
  },
];
