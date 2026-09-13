/**
 * One place that turns "the user filled in a form for tracker type X" into the
 * `documentService.createTrackerItem` payload.
 *
 * Before this existed, every renderer create surface re-derived its own id,
 * status default, and sharing flags, hardcoded `{title, status, priority}`, and
 * skipped schema validation entirely — `globalRegistry.validate()` only ran on
 * the MCP path. A schema that renamed `status` or marked a field required could
 * not be satisfied from the UI at all.
 *
 * Pure: no `window`, no IPC, no clock unless you let it default. `generateId`
 * and `now` are injectable so the result is assertable in tests.
 */
import { type TrackerDataModelRegistry, type TrackerSharing } from './TrackerDataModel';
export interface TrackerValidationIssue {
    field: string;
    message: string;
}
/** Mirrors `documentService.createTrackerItem`'s argument. */
export interface TrackerCreatePayload {
    id: string;
    type: string;
    title: string;
    status: string;
    priority: string;
    workspace: string;
    description?: string;
    content?: string;
    creationRequestId?: string;
    owner?: string;
    tags?: string[];
    customFields?: Record<string, unknown>;
    sharing: TrackerSharing;
    draftByDefault: boolean;
}
export interface TrackerCreateValues {
    title: string;
    description?: string;
    content?: string;
    creationRequestId?: string;
    /**
     * Field values keyed by their name **in this schema** — so a type whose
     * `workflowStatus` role points at `state` supplies `{ state: 'open' }`.
     */
    fields?: Record<string, unknown>;
}
export interface TrackerCreateContext {
    workspacePath: string;
    registry?: TrackerDataModelRegistry;
    generateId?: () => string;
}
export type TrackerCreatePayloadResult = {
    ok: true;
    payload: TrackerCreatePayload;
    warnings: TrackerValidationIssue[];
} | {
    ok: false;
    errors: TrackerValidationIssue[];
};
export declare function buildTrackerCreatePayload(type: string, values: TrackerCreateValues, ctx: TrackerCreateContext): TrackerCreatePayloadResult;
/** Flatten typed validation errors into one line for a form-level message. */
export declare function formatTrackerValidationErrors(errors: TrackerValidationIssue[]): string;
