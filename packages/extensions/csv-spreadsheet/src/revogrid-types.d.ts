/**
 * Re-export RevoGrid global types for use in this extension.
 *
 * The RevoGrid library declares HTMLRevoGridElement in the global scope
 * but doesn't export it as a named export. This file provides the global
 * type reference needed for TypeScript to find these declarations.
 */

/// <reference types="@revolist/revogrid" />

// Re-export the global type for easier importing
export type RevoGridElement = HTMLRevoGridElement;
