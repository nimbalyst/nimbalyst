/**
 * Type inheritance for tracker schemas (`extends`).
 *
 * A derived type declares only what it adds. Resolution folds the ancestry from
 * the root down, so a change to a base type reaches every derived type without
 * anyone editing the derived declaration — that propagation is the whole point,
 * and it is why the DECLARED form is what gets stored and synced while the
 * RESOLVED form is what validation, editors, and tables read.
 *
 * The narrowing rules come from the knowledge-scopes contract: a derived type
 * may add fields and narrow selects; it may not remove or retype a base field.
 * A violation resolves to no model at all rather than to a partially-correct
 * one, so a broken declaration cannot register and silently drop base fields.
 */
import type { TrackerDataModel } from './TrackerDataModel.js';
/** Depth cap on an `extends` chain, counting the derived type itself. */
export declare const TRACKER_INHERITANCE_MAX_DEPTH = 8;
/**
 * A derived type as authored: `type` and `extends` plus only the parts it
 * overrides or adds. Every other property is inherited, so a declaration that
 * omits `displayName` is not a malformed model — it is one that accepts the
 * base's.
 */
export interface DerivedTrackerTypeDeclaration extends Partial<Omit<TrackerDataModel, 'type' | 'extends'>> {
    type: string;
    extends: string;
}
export type TrackerTypeDeclaration = TrackerDataModel | DerivedTrackerTypeDeclaration;
export type TrackerInheritanceErrorCode = 'INHERITANCE_UNKNOWN_BASE' | 'INHERITANCE_CYCLE' | 'INHERITANCE_DEPTH_EXCEEDED' | 'INHERITANCE_FIELD_RETYPED' | 'INHERITANCE_OPTION_WIDENED' | 'INHERITANCE_ROOT_INCOMPLETE';
export interface TrackerInheritanceError {
    code: TrackerInheritanceErrorCode;
    /** Field name, or the type name when the problem is with the chain itself. */
    field: string;
    message: string;
}
export interface TrackerTypeInheritanceResult {
    /** Null when `errors` is non-empty: a partially-resolved type is never returned. */
    model: TrackerDataModel | null;
    errors: TrackerInheritanceError[];
}
/** True for a declaration that inherits from another type. */
export declare function isDerivedTrackerTypeDeclaration(candidate: TrackerTypeDeclaration | null | undefined): candidate is DerivedTrackerTypeDeclaration;
/** Look up a declaration by type name. Returns undefined for an unknown type. */
export type TrackerTypeLookup = (type: string) => TrackerTypeDeclaration | undefined;
/**
 * Resolve one derived declaration against its ancestry.
 *
 * A non-derived declaration resolves to itself, so callers can run everything
 * through this without branching.
 */
export declare function resolveTrackerTypeInheritance(declared: TrackerTypeDeclaration, lookup: TrackerTypeLookup): TrackerTypeInheritanceResult;
/**
 * Recover the declaration a resolved derived model came from: `type`,
 * `extends`, and only what differs from `base` (the base's resolved model).
 *
 * For a copy that lost its declaration -- a mirror row or payload written
 * before declarations travelled with it. Registering such a copy as if it were
 * the declaration turns every inherited field into an explicit override, so a
 * later base change stops reaching it, and narrowing a base select drops the
 * type outright (the copy now "widens" it).
 */
export declare function deriveTrackerTypeDeclaration(resolved: TrackerDataModel, base: TrackerDataModel): DerivedTrackerTypeDeclaration;
