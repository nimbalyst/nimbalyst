/**
 * Where everything on the type map goes. Pure and synchronous:
 *
 * 1. Relationships collapse to one line per pair of types (`buildPairs`).
 * 2. Each zone is laid out on a grid around its hub (`placeZone`): the most
 *    connected type takes the middle cell, and every next type takes the free
 *    cell nearest what it links to, avoiding cells a line would cross.
 * 3. Rows and columns are sized from their boxes, each box reserving the height
 *    it grows to when zoomed in, so an expanded box never covers a neighbour.
 * 4. Zones are packed into rows for the canvas's aspect ratio (`zoneRows`).
 * 5. Lines are curves between the nearest sides, bent around any box in their
 *    way; pills go where they collide with no box, reserved area or other pill.
 */
import type { TypeMapRelationship, TypeMapType, TypeMapZone } from '../ontologyLabelMap';
export declare const NODE_W = 176;
export declare const NODE_H = 52;
export declare const PILL_H = 20;
/** Properties a type box lists when zoomed in; the inspector has the rest. */
export declare const DETAIL_ROWS = 6;
export declare const DETAIL_ROW_H = 17;
export type PairStyle = 'used' | 'unused' | 'off-label' | 'violation';
export interface MapPair {
    id: string;
    /** Source and target of the line: the busiest relationship's direction. */
    from: string;
    to: string;
    relationships: TypeMapRelationship[];
    statements: number;
    style: PairStyle;
    /** Some relationship runs the other way too: arrowheads at both ends. */
    both: boolean;
}
export interface Point {
    x: number;
    y: number;
}
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface PositionedZone extends Rect {
    id: string;
    name: string;
}
export interface PositionedPair {
    id: string;
    path: string;
}
export interface PositionedPill extends Rect {
    relationshipId: string;
    pairId: string;
}
export interface MapLayout {
    width: number;
    height: number;
    /** Compact boxes, as drawn at fit. */
    nodes: Map<string, Rect>;
    /** The space each box grows into when zoomed in; nothing else is placed there. */
    reserved: Map<string, Rect>;
    zones: PositionedZone[];
    pairs: PositionedPair[];
    pills: PositionedPill[];
}
export interface MapLayoutInput {
    types: readonly TypeMapType[];
    zones: readonly TypeMapZone[];
    pairs: readonly MapPair[];
    /** Width over height of the canvas the map is fitted to. */
    aspect?: number;
}
/** Relationships that get a pill at fit: declared and used, and range violations. */
export declare function isMajor(relationship: TypeMapRelationship): boolean;
export declare function buildPairs(relationships: readonly TypeMapRelationship[]): MapPair[];
/**
 * Stroke width. Only declared-and-used lines and range violations grow with
 * their statements; off-label and unused lines stay hairlines whatever their count.
 */
export declare function pairStrokeWidth(pair: Pick<MapPair, 'statements' | 'style'>): number;
export declare function pillWidth(relationship: Pick<TypeMapRelationship, 'verb' | 'statements'>): number;
/** Property rows a type box lists when zoomed in: none for a type with no pages, whose coverage is empty. */
export declare function detailRows(type: Pick<TypeMapType, 'properties' | 'count'>): number;
/** A type box's height when zoomed in far enough to list its properties. */
export declare function expandedHeight(type: Pick<TypeMapType, 'properties' | 'count'>): number;
type Cell = [col: number, row: number];
/**
 * Grid cells for a zone's types, hub in the middle. Deterministic: the same
 * vocabulary always draws the same map.
 */
export declare function placeZone(typeIds: readonly string[], pairs: readonly MapPair[], counts: ReadonlyMap<string, number>, looseColumns?: number): Map<string, Cell>;
/**
 * Zone ids by row, in order, for the arrangement that fits the canvas's
 * aspect ratio at the largest zoom. Every split into rows is tried (zones
 * are few), then the fewest rows among equals.
 */
export declare function zoneRows(sizes: ReadonlyArray<{
    id: string;
    w: number;
    h: number;
}>, aspect?: number): string[][];
export declare function layoutTypeMap(input: MapLayoutInput): MapLayout;
export {};
