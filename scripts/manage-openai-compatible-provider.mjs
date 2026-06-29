import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const action = args.find((arg) => ['--add', '--remove', '--edit'].includes(arg));
const id = action ? args[args.indexOf(action) + 1] : undefined;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  console.error(`Usage:
  node scripts/manage-openai-compatible-provider.mjs --add <id> [--base-url <url>]
  node scripts/manage-openai-compatible-provider.mjs --remove <id>
  node scripts/manage-openai-compatible-provider.mjs --edit <id> [--base-url <url>]`);
  process.exit(1);
}

if (!action || !id || !/^[a-z][a-z0-9-]*$/.test(id)) usage();

const baseUrl = option('--base-url');

function file(relativePath) {
  return path.join(repoRoot, relativePath);
}

function read(relativePath) {
  return readFileSync(file(relativePath), 'utf8');
}

function write(relativePath, content) {
  writeFileSync(file(relativePath), content);
}

function updateConstArray(content, name, updater) {
  const pattern = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`);
  const match = content.match(pattern);
  if (!match) throw new Error(`Could not find ${name}`);

  const values = match[1]
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  const next = updater(values);
  return content.replace(pattern, `export const ${name} = [${next.map((value) => `'${value}'`).join(', ')}] as const;`);
}

function addValue(values, value, after) {
  if (values.includes(value)) return values;
  const index = values.indexOf(after);
  if (index === -1) return [...values, value];
  return [...values.slice(0, index + 1), value, ...values.slice(index + 1)];
}

function removeValue(values, value) {
  return values.filter((item) => item !== value);
}

function updateProviderTypes() {
  const relativePath = 'packages/runtime/src/ai/server/types.ts';
  let content = read(relativePath);

  if (action === '--add') {
    content = updateConstArray(content, 'AI_PROVIDER_TYPES', (values) => addValue(values, id, 'openai'));
    content = updateConstArray(content, 'OPENAI_COMPATIBLE_PROVIDER_TYPES', (values) => addValue(values, id, 'openai'));
  } else if (action === '--remove') {
    content = updateConstArray(content, 'AI_PROVIDER_TYPES', (values) => removeValue(values, id));
    content = updateConstArray(content, 'OPENAI_COMPATIBLE_PROVIDER_TYPES', (values) => removeValue(values, id));
  }

  write(relativePath, content);
}

function updateDefaultModels() {
  const relativePath = 'packages/runtime/src/ai/modelConstants.ts';
  let content = read(relativePath);
  const line = `  ${id.includes('-') ? `'${id}'` : id}: '${id}:local-model',`;

  if (action === '--add' && !content.includes(line)) {
    content = content.replace("  openai: 'openai:gpt-5.5',", `  openai: 'openai:gpt-5.5',\n${line}`);
  } else if (action === '--remove') {
    content = content.replace(new RegExp(`\\n  ${id.includes('-') ? `'${id}'` : id}: '${id}:local-model',`), '');
  }

  write(relativePath, content);
}

function updateDefaultBaseUrl() {
  const relativePath = 'packages/electron/src/main/services/ai/lmStudioConfig.ts';
  let content = read(relativePath);

  content = content.replace(new RegExp(`\\n  ${id.includes('-') ? `'${id}'` : id}: '[^']*',`), '');

  if ((action === '--add' || action === '--edit') && baseUrl) {
    const line = `  ${id.includes('-') ? `'${id}'` : id}: '${baseUrl}',`;
    content = content.replace(
      /export const OPENAI_COMPATIBLE_PROVIDER_DEFAULT_BASE_URLS: Partial<Record<OpenAICompatibleProviderType, string>> = \{\n/,
      (prefix) => `${prefix}${line}\n`,
    );
  }

  write(relativePath, content);
}

updateProviderTypes();
updateDefaultModels();
updateDefaultBaseUrl();

console.log(`[manage-openai-compatible-provider] ${action.slice(2)} ${id}`);
console.log('Follow-up checklist: ProviderFactory, ModelRegistry, settings registry/defaults, SettingsView, SettingsSidebar, ProjectAIProvidersPanel, ModelSelector, modelUtils, ProviderIcons, and AIService.');
