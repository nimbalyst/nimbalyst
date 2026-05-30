/**
 * Tip: Spreadsheet Mode Discovery
 *
 * Encourages active AI users to leave CSVs in spreadsheet mode rather than
 * flipping to source view -- sorting, formulas, and AI tools all work there.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const TableIcon = <MaterialSymbol icon="table_chart" size={16} />;

export const spreadsheetDiscoverTip: TipDefinition = {
  id: 'tip-spreadsheet-discover',
  name: 'Spreadsheet Mode Discovery',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED_WITH_TOOLS, 5) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.SPREADSHEET_OPENED),
    delay: 2000,
    priority: 4,
  },
  content: {
    icon: TableIcon,
    title: 'CSV files open as spreadsheets',
    body: 'Drop a **.csv** in the workspace and it opens with sorting, formulas, and AI tooling -- no need to flip to source view to make edits.',
  },
};
