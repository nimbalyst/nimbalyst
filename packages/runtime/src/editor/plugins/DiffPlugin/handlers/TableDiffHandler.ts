/**
 * Handler for table node diffs.
 *
 * Uses row-level LCS (longest common subsequence) to align source and target
 * rows. Aligned rows that match exactly stay unchanged; aligned rows whose
 * cell contents partially match (>=50% of cells equal by markdown) are paired
 * as 'modified' and get cell-level diffs; unpaired source rows are marked
 * 'removed' and unpaired target rows are marked 'added'.
 *
 * Within a 'modified' row, each cell whose markdown differs gets the old
 * content as a 'removed'-marked paragraph followed by the new content as an
 * 'added'-marked paragraph (the same pattern paragraphs use), so both old and
 * new are visible in-cell. Approve/reject then strip the appropriate side.
 */

import type {DiffHandlerContext, DiffHandlerResult, DiffNodeHandler} from './DiffNodeHandler';
import type {LexicalNode, SerializedLexicalNode} from 'lexical';
import type {Transformer} from '@lexical/markdown';
import {$isElementNode, ElementNode} from 'lexical';
import {$isTableCellNode, $isTableNode, $isTableRowNode} from '@lexical/table';
import {createNodeFromSerialized} from '../core/createNodeFromSerialized';
import {
    $clearDiffState,
    $clearOriginalMarkdown,
    $getDiffState,
    $setDiffState,
    $setOriginalMarkdown,
} from '../core/DiffState';
import {
    $convertNodeToEnhancedMarkdownString,
    $convertFromEnhancedMarkdownString,
} from '../../../markdown';

// Row whose cell-by-cell similarity to a partner must be at least this
// fraction for the pair to be merged into a single 'modified' row instead of
// being split into separate 'removed' + 'added' rows. Using min(source.length,
// target.length) as the denominator means a column-add (one extra target cell)
// still pairs at 100%.
const ROW_SIMILARITY_THRESHOLD = 0.5;

type SerializedTableRow = SerializedLexicalNode & {children?: SerializedLexicalNode[]};

type RowAlignmentStep =
    | {kind: 'unchanged'; source: SerializedTableRow; target: SerializedTableRow}
    | {kind: 'modified'; source: SerializedTableRow; target: SerializedTableRow}
    | {kind: 'removed'; source: SerializedTableRow}
    | {kind: 'added'; target: SerializedTableRow};

export class TableDiffHandler implements DiffNodeHandler {
    readonly nodeType = 'table';

    canHandle(context: DiffHandlerContext): boolean {
        return context.liveNode.getType() === 'table' ||
            context.targetNode?.type === 'table' ||
            context.sourceNode?.type === 'table';
    }

    handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
        const {liveNode, targetNode, sourceNode, transformers} = context;

        if (!$isTableNode(liveNode)) {
            console.warn('TableDiffHandler: liveNode is not a table');
            return {handled: false};
        }
        if (targetNode.type !== 'table') {
            console.warn('TableDiffHandler: targetNode is not a table');
            return {handled: false};
        }
        if (!sourceNode || sourceNode.type !== 'table') {
            console.warn('TableDiffHandler: sourceNode is not a table');
            return {handled: false};
        }

        try {
            const sourceRows = this.getRows(sourceNode);
            const targetRows = this.getRows(targetNode);
            const xforms = transformers || [];

            const alignment = this.computeRowAlignment(sourceRows, targetRows, xforms);
            const hasChange = alignment.some(step => step.kind !== 'unchanged');
            if (!hasChange) {
                return {handled: true, skipChildren: true};
            }

            // Preserve original markdown of the whole table for diagnostics / legacy fallback.
            const originalMarkdown = $convertNodeToEnhancedMarkdownString(xforms, liveNode);
            $setOriginalMarkdown(liveNode, originalMarkdown);

            // Clear and rebuild the table according to the alignment.
            liveNode.getChildren().forEach(child => child.remove());

            for (const step of alignment) {
                if (step.kind === 'unchanged') {
                    const row = createNodeFromSerialized(step.target);
                    if ($isTableRowNode(row)) liveNode.append(row);
                } else if (step.kind === 'added') {
                    const row = createNodeFromSerialized(step.target);
                    if ($isTableRowNode(row)) {
                        $setDiffState(row, 'added');
                        for (const cell of row.getChildren()) {
                            if ($isTableCellNode(cell)) $setDiffState(cell, 'added');
                        }
                        liveNode.append(row);
                    }
                } else if (step.kind === 'removed') {
                    const row = createNodeFromSerialized(step.source);
                    if ($isTableRowNode(row)) {
                        $setDiffState(row, 'removed');
                        for (const cell of row.getChildren()) {
                            if ($isTableCellNode(cell)) $setDiffState(cell, 'removed');
                        }
                        liveNode.append(row);
                    }
                } else if (step.kind === 'modified') {
                    // Build the row from the target structure, then walk cells and
                    // either leave them alone (unchanged), mark them 'added' (new
                    // column cell), or rewrite them to show old + new content.
                    const row = createNodeFromSerialized(step.target);
                    if ($isTableRowNode(row)) {
                        this.applyCellLevelDiff(row, step.source, step.target, xforms);
                        liveNode.append(row);
                    }
                }
            }

            $setDiffState(liveNode, 'modified');
            return {handled: true, skipChildren: true};
        } catch (error) {
            console.error('TableDiffHandler: Error updating table:', error);
            return {
                handled: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    handleAdd(
        targetNode: SerializedLexicalNode,
        parentNode: ElementNode,
        position: number,
    ): DiffHandlerResult {
        if (targetNode.type !== 'table') return {handled: false};

        try {
            const newTable = createNodeFromSerialized(targetNode);
            if (!$isElementNode(newTable)) return {handled: false};

            $setDiffState(newTable, 'added');

            const children = parentNode.getChildren();
            if (position < children.length) {
                children[position].insertBefore(newTable);
            } else {
                parentNode.append(newTable);
            }
            return {handled: true};
        } catch (error) {
            return {handled: false, error: error instanceof Error ? error.message : String(error)};
        }
    }

    handleRemove(liveNode: LexicalNode): DiffHandlerResult {
        if (!$isTableNode(liveNode)) return {handled: false};
        try {
            $setDiffState(liveNode, 'removed');
            return {handled: true};
        } catch (error) {
            return {handled: false, error: error instanceof Error ? error.message : String(error)};
        }
    }

    handleApprove(liveNode: LexicalNode): DiffHandlerResult {
        if (!$isTableNode(liveNode)) return {handled: false};

        // The caller in $approveDiffs already cleared the table's 'modified'
        // diff state before invoking us. Walk the table interior and resolve
        // remaining row/cell/cell-content diff state the same way the default
        // recursion would, just without re-entering the registry per node.
        $clearOriginalMarkdown(liveNode);
        this.resolveTableInterior(liveNode, 'approve');
        return {handled: true, skipChildren: true};
    }

    handleReject(liveNode: LexicalNode): DiffHandlerResult {
        if (!$isTableNode(liveNode)) return {handled: false};

        if ($getDiffState(liveNode) === 'modified') {
            $clearDiffState(liveNode);
        }
        $clearOriginalMarkdown(liveNode);
        this.resolveTableInterior(liveNode, 'reject');
        return {handled: true, skipChildren: true};
    }

    /**
     * Walk every row, cell, and cell-content node in the table and resolve
     * their diff states.
     *
     * - approve mode: 'removed' nodes are deleted; 'added' / 'modified' are kept and cleared.
     * - reject mode: 'added' nodes are deleted; 'removed' / 'modified' are kept and cleared.
     */
    private resolveTableInterior(table: LexicalNode, mode: 'approve' | 'reject'): void {
        if (!$isTableNode(table)) return;

        const rows = [...table.getChildren()];
        for (const row of rows) {
            if (!$isTableRowNode(row)) continue;

            const rowState = $getDiffState(row);
            if (rowState === 'removed' && mode === 'approve') {
                row.remove();
                continue;
            }
            if (rowState === 'added' && mode === 'reject') {
                row.remove();
                continue;
            }
            if (rowState) {
                $clearDiffState(row);
            }

            // Walk cells.
            const cells = [...row.getChildren()];
            for (const cell of cells) {
                if (!$isTableCellNode(cell)) continue;

                const cellState = $getDiffState(cell);
                if (cellState === 'removed' && mode === 'approve') {
                    cell.remove();
                    continue;
                }
                if (cellState === 'added' && mode === 'reject') {
                    cell.remove();
                    continue;
                }
                if (cellState) {
                    $clearDiffState(cell);
                }
                $clearOriginalMarkdown(cell);

                // Walk cell content (paragraphs etc. that we attached with
                // 'removed'/'added' state for in-cell content diffs).
                const contents = [...cell.getChildren()];
                for (const c of contents) {
                    const contentState = $getDiffState(c);
                    if (contentState === 'removed' && mode === 'approve') {
                        c.remove();
                        continue;
                    }
                    if (contentState === 'added' && mode === 'reject') {
                        c.remove();
                        continue;
                    }
                    if (contentState) {
                        $clearDiffState(c);
                    }
                }
            }
        }
    }

    /**
     * Within a row already in target shape, replace each modified cell's
     * content with [original-as-removed-paragraph(s), new-as-added-paragraph(s)]
     * so both versions are visible. Cells that are unchanged stay alone.
     * Cells that are new columns (no source counterpart) are marked 'added'.
     */
    private applyCellLevelDiff(
        liveRow: LexicalNode,
        sourceRow: SerializedTableRow,
        targetRow: SerializedTableRow,
        transformers: Transformer[],
    ): void {
        if (!$isTableRowNode(liveRow)) return;

        const sourceCells = (sourceRow.children || []) as SerializedLexicalNode[];
        const targetCells = (targetRow.children || []) as SerializedLexicalNode[];
        const liveCells = liveRow.getChildren();

        for (let i = 0; i < liveCells.length; i++) {
            const liveCell = liveCells[i];
            if (!$isTableCellNode(liveCell)) continue;

            const sourceCell = sourceCells[i];
            const targetCell = targetCells[i];

            // Live row is built from target, so the cell is the target cell;
            // a missing source counterpart means this cell is in a new column.
            if (!sourceCell && targetCell) {
                $setDiffState(liveCell, 'added');
                continue;
            }
            if (!targetCell && sourceCell) {
                // Target is missing a cell that source had. Live row was built
                // from target so it doesn't have this cell to mark; column-
                // remove rendering is left as a known limitation.
                continue;
            }
            if (!sourceCell || !targetCell) continue;

            const sourceMd = this.getCellMarkdown(sourceCell, transformers);
            const targetMd = this.getCellMarkdown(targetCell, transformers);
            if (sourceMd === targetMd) continue;

            // Replace the cell's current (target) content with old-as-removed
            // followed by new-as-added so both are visible.
            liveCell.getChildren().forEach(child => child.remove());

            if (sourceMd.trim()) {
                const beforeCount = liveCell.getChildrenSize();
                $convertFromEnhancedMarkdownString(sourceMd, transformers, liveCell, true, false);
                const newChildren = liveCell.getChildren().slice(beforeCount);
                for (const c of newChildren) $setDiffState(c, 'removed');
            }
            if (targetMd.trim()) {
                const beforeCount = liveCell.getChildrenSize();
                $convertFromEnhancedMarkdownString(targetMd, transformers, liveCell, true, false);
                const newChildren = liveCell.getChildren().slice(beforeCount);
                for (const c of newChildren) $setDiffState(c, 'added');
            }

            $setOriginalMarkdown(liveCell, sourceMd);
            $setDiffState(liveCell, 'modified');
        }
    }

    /**
     * Align source and target rows using LCS over exact-match row markdown.
     * Then walk the result and pair adjacent removed/added rows into
     * 'modified' steps when their cell-by-cell similarity meets the
     * threshold. This gives row-add/remove markers for unmatched rows and
     * cell-level diffs for matched-but-edited rows.
     */
    private computeRowAlignment(
        sourceRows: SerializedTableRow[],
        targetRows: SerializedTableRow[],
        transformers: Transformer[],
    ): RowAlignmentStep[] {
        const sourceMd = sourceRows.map(r => this.getRowMarkdown(r, transformers));
        const targetMd = targetRows.map(r => this.getRowMarkdown(r, transformers));

        const m = sourceRows.length;
        const n = targetRows.length;

        // LCS dp table
        const dp: number[][] = Array.from({length: m + 1}, () => new Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (sourceMd[i - 1] === targetMd[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack
        const reverse: RowAlignmentStep[] = [];
        let i = m, j = n;
        while (i > 0 && j > 0) {
            if (sourceMd[i - 1] === targetMd[j - 1]) {
                reverse.push({kind: 'unchanged', source: sourceRows[i - 1], target: targetRows[j - 1]});
                i--;
                j--;
            } else if (dp[i - 1][j] >= dp[i][j - 1]) {
                reverse.push({kind: 'removed', source: sourceRows[i - 1]});
                i--;
            } else {
                reverse.push({kind: 'added', target: targetRows[j - 1]});
                j--;
            }
        }
        while (i > 0) {
            i--;
            reverse.push({kind: 'removed', source: sourceRows[i]});
        }
        while (j > 0) {
            j--;
            reverse.push({kind: 'added', target: targetRows[j]});
        }
        const steps = reverse.reverse();

        return this.mergeIntoModifiedPairs(steps, transformers);
    }

    /**
     * Pair consecutive 'removed' and 'added' steps into a single 'modified'
     * step when their cell similarity is high enough. Order is preserved by
     * emitting at the position of the matched 'removed' step and skipping
     * the matched 'added' step.
     */
    private mergeIntoModifiedPairs(
        steps: RowAlignmentStep[],
        transformers: Transformer[],
    ): RowAlignmentStep[] {
        const result: RowAlignmentStep[] = [];

        let i = 0;
        while (i < steps.length) {
            if (steps[i].kind === 'unchanged') {
                result.push(steps[i]);
                i++;
                continue;
            }

            // Collect a contiguous run of non-unchanged steps.
            const runStart = i;
            while (i < steps.length && steps[i].kind !== 'unchanged') i++;
            const run = steps.slice(runStart, i);

            const usedAdded = new Set<number>();
            const pairings = new Map<number, number>(); // gap-local removed idx -> added idx

            for (let r = 0; r < run.length; r++) {
                if (run[r].kind !== 'removed') continue;
                let bestIdx = -1;
                let bestScore = 0;
                for (let a = 0; a < run.length; a++) {
                    if (run[a].kind !== 'added' || usedAdded.has(a)) continue;
                    const score = this.computeRowSimilarity(
                        (run[r] as Extract<RowAlignmentStep, {kind: 'removed'}>).source,
                        (run[a] as Extract<RowAlignmentStep, {kind: 'added'}>).target,
                        transformers,
                    );
                    if (score > bestScore && score >= ROW_SIMILARITY_THRESHOLD) {
                        bestScore = score;
                        bestIdx = a;
                    }
                }
                if (bestIdx >= 0) {
                    usedAdded.add(bestIdx);
                    pairings.set(r, bestIdx);
                }
            }

            for (let g = 0; g < run.length; g++) {
                const step = run[g];
                if (step.kind === 'added' && usedAdded.has(g)) continue; // already emitted as part of a pair

                if (step.kind === 'removed' && pairings.has(g)) {
                    const pairedAdded = run[pairings.get(g)!];
                    if (pairedAdded.kind === 'added') {
                        result.push({
                            kind: 'modified',
                            source: step.source,
                            target: pairedAdded.target,
                        });
                        continue;
                    }
                }
                result.push(step);
            }
        }

        return result;
    }

    private computeRowSimilarity(
        sourceRow: SerializedTableRow | undefined,
        targetRow: SerializedTableRow | undefined,
        transformers: Transformer[],
    ): number {
        if (!sourceRow || !targetRow) return 0;
        const sourceCells = (sourceRow.children || []) as SerializedLexicalNode[];
        const targetCells = (targetRow.children || []) as SerializedLexicalNode[];
        const denom = Math.min(sourceCells.length, targetCells.length);
        if (denom === 0) return 0;

        let matches = 0;
        for (let i = 0; i < denom; i++) {
            const sMd = this.getCellMarkdown(sourceCells[i], transformers);
            const tMd = this.getCellMarkdown(targetCells[i], transformers);
            if (sMd === tMd) matches++;
        }
        return matches / denom;
    }

    private getRowMarkdown(row: SerializedTableRow, transformers: Transformer[]): string {
        const cells = (row.children || []) as SerializedLexicalNode[];
        // Use a separator that won't appear inside a single cell to keep the
        // join unambiguous for equality.
        return cells.map(c => this.getCellMarkdown(c, transformers)).join('');
    }

    private getCellMarkdown(cell: SerializedLexicalNode | undefined, transformers: Transformer[]): string {
        if (!cell || cell.type !== 'tablecell') return '';
        try {
            const tempCell = createNodeFromSerialized(cell);
            if ($isTableCellNode(tempCell)) {
                return $convertNodeToEnhancedMarkdownString(transformers, tempCell);
            }
        } catch {
            // Fall through to text extraction
        }
        return this.extractCellText(cell as SerializedTableRow);
    }

    private getRows(tableNode: SerializedLexicalNode): SerializedTableRow[] {
        if (!tableNode || !('children' in tableNode)) return [];
        const children = (tableNode as SerializedTableRow).children;
        if (!Array.isArray(children)) return [];
        return children as SerializedTableRow[];
    }

    /**
     * Plain-text fallback extraction in case createNodeFromSerialized fails.
     */
    private extractCellText(cell: SerializedTableRow): string {
        if (!cell || !cell.children) return '';
        let text = '';
        for (const child of cell.children) {
            const c = child as SerializedTableRow;
            if (c && c.type === 'paragraph' && c.children) {
                for (const tn of c.children) {
                    const t = tn as {type?: string; text?: string};
                    if (t && t.type === 'text' && typeof t.text === 'string') {
                        text += t.text;
                    }
                }
            }
        }
        return text;
    }
}
