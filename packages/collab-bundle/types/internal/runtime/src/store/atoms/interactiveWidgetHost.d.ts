/**
 * Interactive Widget Host Atoms
 *
 * Per-session host for interactive tool widgets (AskUserQuestion, ExitPlanMode,
 * GitCommit, ToolPermission, etc.). Widgets read the host from the atom via
 * `useAtomValue(interactiveWidgetHostAtom(sessionId))` and call its methods.
 *
 * Registration is multi-owner: the same session can be displayed by more than
 * one `SessionTranscript` at a time (e.g. once in Files-mode ChatSidebar and
 * once in Agent mode). If two transcripts compete for the same atom slot with
 * single-owner semantics, the second mount's StrictMode cleanup, or the first
 * cleanup-without-immediate-resetup, leaves the atom at `null` and the
 * surviving transcript has no way to notice it should re-register. That's the
 * regression where AskUserQuestion's options stop rendering after switching
 * Files <-> Agent.
 *
 * Instead we keep a module-local `Set` of live proxies per session. The atom
 * value tracks "any live proxy" -- swapping to a surviving one when the
 * currently-published one unregisters. Atom is only set to null when the last
 * owner disappears.
 */
import type { InteractiveWidgetHost } from '../../ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
/**
 * Per-session interactive widget host atom. Read by widgets.
 */
export declare const interactiveWidgetHostAtom: import("jotai-family").AtomFamily<string, import("jotai").PrimitiveAtom<InteractiveWidgetHost | null> & {
    init: InteractiveWidgetHost | null;
}>;
/**
 * Register a host for a session. Idempotent (safe to call with the same proxy
 * twice in a StrictMode double-invoke). The atom is updated so the newest
 * registrant is published, but earlier registrants are kept as fallback so a
 * later unregister can hand off to a surviving owner instead of nulling out.
 */
export declare function registerInteractiveWidgetHost(sessionId: string, host: InteractiveWidgetHost): void;
/**
 * Unregister a host. If it was the currently-published owner, fall back to any
 * other live owner; only set the atom to null when the last owner is gone.
 */
export declare function unregisterInteractiveWidgetHost(sessionId: string, host: InteractiveWidgetHost): void;
/**
 * @deprecated Prefer `registerInteractiveWidgetHost` / `unregisterInteractiveWidgetHost`.
 * Kept for tests and any external callers that directly toggle the atom.
 * Bypasses the multi-owner registry, so a null write here clobbers any live
 * owners.
 */
export declare function setInteractiveWidgetHost(sessionId: string, host: InteractiveWidgetHost | null): void;
/**
 * Get the currently-published host for a session.
 */
export declare function getInteractiveWidgetHost(sessionId: string): InteractiveWidgetHost | null;
/**
 * Cleanup atom for a session (call when session is deleted).
 */
export declare function cleanupInteractiveWidgetHost(sessionId: string): void;
