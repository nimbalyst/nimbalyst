/**
 * Load a tracker type schema from a file for `nim tracker types define`.
 * Accepts JSON (`.json`) or YAML (`.yaml` / `.yml`).
 */
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { usageError } from '../cli/exitCodes.js';

export interface LoadedTypeSchema {
  schema: Record<string, unknown> & { type?: string };
  fileName?: string;
}

export function loadTypeSchema(file: string): LoadedTypeSchema {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    throw usageError(`Could not read schema file "${file}": ${err?.message ?? err}`);
  }

  const ext = path.extname(file).toLowerCase();
  let parsed: unknown;
  try {
    parsed = ext === '.json' ? JSON.parse(raw) : yaml.load(raw);
  } catch (err: any) {
    throw usageError(`Could not parse "${file}": ${err?.message ?? err}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usageError(`Schema file "${file}" must contain a single object.`);
  }

  const schema = parsed as Record<string, unknown> & { type?: string };
  if (!schema.type || typeof schema.type !== 'string') {
    throw usageError(`Schema in "${file}" must include a string "type" field.`);
  }

  // Persist YAML inputs under their own filename; JSON gets a derived .yaml name.
  const base = path.basename(file);
  const fileName = ext === '.yaml' || ext === '.yml' ? base : `${schema.type}.yaml`;
  return { schema, fileName };
}
