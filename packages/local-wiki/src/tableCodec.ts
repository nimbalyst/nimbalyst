import { joinMultiValue, splitMultiValue } from './csv.js';
import type { WikiFieldDef, WikiTypeDef } from './typeDefs.js';

type Encoding = 'text' | 'multi' | 'json' | 'number' | 'boolean' | 'ref' | 'url';

function encodingFor(field: WikiFieldDef | undefined): Encoding {
  if (!field) return 'text';
  switch (field.type) {
    case 'multiselect':
    case 'label-ref':
      return 'multi';
    case 'array':
      return field.itemType === 'object' ? 'json' : 'multi';
    case 'relationship':
    case 'reference':
      return field.multiValue ? 'multi' : 'ref';
    case 'object':
    case 'citation':
      return 'json';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'url':
      return 'url';
    default:
      return 'text';
  }
}

/** A relationship value may arrive as an id or as `{ itemId }`; files hold the id. */
function refId(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as { itemId?: unknown }).itemId === 'string') {
    return (value as { itemId: string }).itemId;
  }
  return String(value);
}

export function encodeCell(value: unknown, field: WikiFieldDef | undefined): string {
  if (value === undefined || value === null) return '';
  switch (encodingFor(field)) {
    case 'multi': {
      const list = Array.isArray(value) ? value : [value];
      return joinMultiValue(list.map(refId));
    }
    case 'ref':
      return refId(value);
    case 'json':
      return JSON.stringify(value);
    case 'url':
      if (typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') return (value as { url: string }).url;
      return String(value);
    case 'boolean':
      return value === true || value === 'true' ? 'true' : 'false';
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

export function decodeCell(cell: string, field: WikiFieldDef | undefined): unknown {
  if (cell === '') return undefined;
  switch (encodingFor(field)) {
    case 'multi':
      return splitMultiValue(cell);
    case 'json':
      try {
        return JSON.parse(cell);
      } catch {
        return cell;
      }
    case 'number': {
      const n = Number(cell);
      return Number.isFinite(n) ? n : cell;
    }
    case 'boolean':
      return cell.trim().toLowerCase() === 'true';
    default:
      return cell;
  }
}

/** `id`, then the existing columns in their order, then type fields the file lacks. */
export function tableHeader(existing: readonly string[], def: WikiTypeDef | undefined): string[] {
  const header = existing.length > 0 ? [...existing] : ['id'];
  const have = new Set(header);
  for (const field of def?.fields ?? []) {
    if (!have.has(field.name)) {
      header.push(field.name);
      have.add(field.name);
    }
  }
  return header;
}

export function decodeRow(header: readonly string[], row: readonly string[], def: WikiTypeDef | undefined): { id: string; fields: Record<string, unknown> } {
  const byName = new Map((def?.fields ?? []).map((f) => [f.name, f]));
  const fields: Record<string, unknown> = {};
  for (let i = 1; i < header.length; i++) {
    const value = decodeCell(row[i] ?? '', byName.get(header[i]));
    if (value !== undefined) fields[header[i]] = value;
  }
  return { id: (row[0] ?? '').trim(), fields };
}

export function encodeRow(header: readonly string[], id: string, fields: Record<string, unknown>, def: WikiTypeDef | undefined): string[] {
  const byName = new Map((def?.fields ?? []).map((f) => [f.name, f]));
  return header.map((column, i) => (i === 0 ? id : encodeCell(fields[column], byName.get(column))));
}
