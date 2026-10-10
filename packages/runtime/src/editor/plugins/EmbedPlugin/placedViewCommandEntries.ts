/**
 * The slash entries for placing a view in a page: a table per type, a board
 * and a chart for a type with something to group by, a 2x2 for a type with
 * two number fields, and the decisions and open questions lists.
 * The menu itself is the picker; the placed link carries the definition and
 * can be edited in the markdown afterwards.
 *
 * Each entry dispatches `INSERT_PLACED_VIEW_COMMAND` without a scope; the
 * host's handler adds the page's own scope. Pure, so the browser editor can
 * build the same entries from the types its host lists.
 */

import type { UserCommand } from '../../types/PluginTypes';
import { INSERT_PLACED_VIEW_COMMAND, type PlacedViewInsertPayload } from './placedViewInsert';

/** The part of a type definition the entries read. */
export interface PlacedViewTypeOption {
  type: string;
  displayName?: string;
  displayNamePlural?: string;
  fields: ReadonlyArray<{ name: string; type: string; multiValue?: boolean; role?: string }>;
}

const command = INSERT_PLACED_VIEW_COMMAND as UserCommand['command'];

function entry(title: string, description: string, icon: string, keywords: string[], payload: PlacedViewInsertPayload): UserCommand {
  return { title, description, icon, keywords: ['view', 'embed', ...keywords], command, payload };
}

export function buildPlacedViewCommandEntries(types: readonly PlacedViewTypeOption[]): UserCommand[] {
  const commands: UserCommand[] = [];
  for (const model of types) {
    const name = model.displayNamePlural || model.displayName || model.type;
    const target = { kind: 'type', typeId: model.type } as const;
    commands.push(entry(`Table: ${name}`, `A live table of ${name}; editing a cell edits the page`, 'table_view', ['table', name], { target, label: name }));
    const grouping = model.fields.find(field => field.type === 'select' && !field.multiValue && (field.name === 'status' || field.role === 'status'))
      ?? model.fields.find(field => field.type === 'select' && !field.multiValue);
    if (grouping) commands.push(entry(`Board: ${name}`, `${name} grouped by ${grouping.name}`, 'view_kanban', ['board', name], {
      target, label: name, attrs: { mode: 'board', group: grouping.name, ordering: 'manual' },
    }));
    // Count by the board's grouping, else by a person, else by month of a date.
    const chartBy = grouping
      ?? model.fields.find(field => field.type === 'user' && !field.multiValue)
      ?? model.fields.find(field => (field.type === 'date' || field.type === 'datetime') && !field.multiValue);
    if (chartBy) commands.push(entry(`Chart: ${name}`, `A chart of ${name} counted by ${chartBy.name}`, 'bar_chart', ['chart', 'graph', name], {
      target, label: name, attrs: { mode: 'chart', chart: 'bar', by: chartBy.name },
    }));
    const numbers = model.fields.filter((field) => field.type === 'number');
    if (numbers.length >= 2) {
      commands.push(entry(`2x2: ${name}`, `${name} placed by ${numbers[0].name} and ${numbers[1].name}`, 'grid_view', ['2x2', 'quadrant', 'chart', name], {
        target,
        label: name,
        attrs: { mode: '2x2', x: numbers[0].name, y: numbers[1].name },
      }));
    }
  }
  commands.push(
    entry('Decisions list', 'Every sentence marked decided, across pages', 'gavel', ['decisions', 'decided', 'marks'], {
      target: { kind: 'marks', marks: 'decided' }, label: 'Decisions',
    }),
    entry('Open questions list', 'Every sentence marked open, across pages', 'help', ['open', 'questions', 'marks'], {
      target: { kind: 'marks', marks: 'open' }, label: 'Open questions',
    }),
  );
  return commands;
}
