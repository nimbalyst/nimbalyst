/**
 * Build-time validation for extension bundles.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  validateAgentProviders,
  validateBackendModules,
} from './manifestValidation.js';
import type { ValidationResult } from './validationTypes.js';
export type { ValidationResult } from './validationTypes.js';

/**
 * Validates an extension bundle for common issues.
 *
 * Run this after building to catch configuration mistakes before runtime.
 *
 * @param distPath - Path to the dist directory containing the bundle
 * @param bundleName - Name of the bundle file (default: 'index.js')
 *
 * @example
 * ```ts
 * const result = await validateExtensionBundle('./dist');
 * if (!result.valid) {
 *   console.error('Build failed:', result.errors);
 *   process.exit(1);
 * }
 * ```
 */
export async function validateExtensionBundle(
  distPath: string,
  bundleName = 'index.js'
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const bundlePath = path.join(distPath, bundleName);

  // Check bundle exists
  if (!fs.existsSync(bundlePath)) {
    errors.push(`Bundle not found at ${bundlePath}`);
    return { valid: false, errors, warnings };
  }

  const bundle = fs.readFileSync(bundlePath, 'utf8');

  // Check for dev runtime usage (jsxDEV)
  // This is now just a warning since we have a shim, but it's still not ideal
  if (bundle.includes('jsxDEV') && bundle.includes('jsx-dev-runtime')) {
    warnings.push(
      'Extension uses jsxDEV from react/jsx-dev-runtime. ' +
        'This works but is not recommended. Set mode: "production" in vite config ' +
        'and configure @vitejs/plugin-react with jsxRuntime: "automatic".'
    );
  }

  // Check for bundled React (should be external)
  if (
    bundle.includes('react.production.min.js') ||
    bundle.includes('react.development.js') ||
    bundle.includes('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED')
  ) {
    errors.push(
      'Extension appears to bundle React. This will cause runtime errors. ' +
        'Add "react" and "react-dom" to rollupOptions.external, or use createExtensionConfig().'
    );
  }

  // Check for bundled Lexical (should be external)
  if (
    bundle.includes('$getRoot') &&
    bundle.includes('$getSelection') &&
    bundle.length > 500000 // Lexical adds significant size
  ) {
    warnings.push(
      'Extension may be bundling Lexical. If you use Lexical nodes, ' +
        'add "lexical" and "@lexical/*" to rollupOptions.external.'
    );
  }

  // Check for unresolved process.env references
  if (bundle.includes('process.env.NODE_ENV')) {
    warnings.push(
      'Bundle contains process.env.NODE_ENV references that were not replaced. ' +
        'Add define: { "process.env.NODE_ENV": JSON.stringify("production") } to vite config.'
    );
  }

  // Check for CommonJS artifacts that might cause issues
  if (bundle.includes('require(') && !bundle.includes('require.resolve')) {
    warnings.push(
      'Bundle contains require() calls which may not work in the browser. ' +
        'Ensure all dependencies are ESM-compatible or properly bundled.'
    );
  }

  // Check manifest exists
  const manifestPath = path.join(path.dirname(distPath), 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    warnings.push(
      `No manifest.json found at ${manifestPath}. ` +
        'Extensions need a manifest.json to be loaded by Nimbalyst.'
    );
  } else {
    // Validate manifest
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      if (!manifest.id) {
        errors.push('manifest.json is missing required "id" field');
      }

      if (!manifest.name) {
        errors.push('manifest.json is missing required "name" field');
      }

      if (!manifest.main) {
        errors.push('manifest.json is missing required "main" field');
      } else {
        // Check main points to existing file
        const mainPath = path.join(path.dirname(manifestPath), manifest.main);
        if (!fs.existsSync(mainPath)) {
          errors.push(
            `manifest.json "main" points to ${manifest.main} but file does not exist`
          );
        }
      }

      if (manifest.styles) {
        const stylesPath = path.join(path.dirname(manifestPath), manifest.styles);
        if (!fs.existsSync(stylesPath)) {
          warnings.push(
            `manifest.json "styles" points to ${manifest.styles} but file does not exist`
          );
        }
      }

      // Validate backendModules if present. These run outside the renderer
      // under a host-managed permission system; malformed declarations would
      // either fail to load at runtime or, worse, declare unknown permission
      // ids the consent prompt can't render. Catch both at build time.
      const backendModulesIssues = validateBackendModules(
        manifest?.contributions?.backendModules
      );
      for (const issue of backendModulesIssues) {
        errors.push(issue.message);
      }

      // Also check the declared entry files exist on disk.
      if (Array.isArray(manifest?.contributions?.backendModules)) {
        for (const module of manifest.contributions.backendModules as Array<Record<string, unknown>>) {
          if (typeof module?.entry === 'string') {
            const entryPath = path.join(path.dirname(manifestPath), module.entry);
            if (!fs.existsSync(entryPath)) {
              errors.push(
                `backendModules[${module.id ?? '?'}].entry points to ${module.entry} but file does not exist`
              );
            }
          }
        }
      }

      // Validate aiAgentProviders contributions: id/name/backendModuleId
      // shape, uniqueness, model fields, toolFileLinks keys, and provider
      // count cap. Cross-references contributions.backendModules so a typo
      // in backendModuleId fails the build instead of erroring at runtime.
      const agentProviderIssues = validateAgentProviders(
        manifest?.contributions?.aiAgentProviders,
        manifest?.contributions?.backendModules
      );
      for (const issue of agentProviderIssues) {
        if (issue.severity === 'warning') {
          warnings.push(issue.message);
        } else {
          errors.push(issue.message);
        }
      }

      // For each agent provider, verify that the backend module it points at
      // actually exports a usable entry point in the built bundle. The
      // privileged host will either call `activate(context)` (the generic
      // BackendModule contract) or `createAgentProvider(context)` (the
      // agent-provider factory) -- catching missing exports here keeps a
      // broken contribution from reaching the consent prompt.
      if (Array.isArray(manifest?.contributions?.aiAgentProviders)) {
        // Build a quick lookup so the per-provider check below can find the
        // corresponding backend-module entry path without re-scanning the
        // array each time.
        const moduleEntries = new Map<string, string>();
        if (Array.isArray(manifest?.contributions?.backendModules)) {
          for (const moduleRaw of manifest.contributions.backendModules as Array<Record<string, unknown>>) {
            const id = moduleRaw?.id;
            const entry = moduleRaw?.entry;
            if (typeof id === 'string' && typeof entry === 'string') {
              moduleEntries.set(id, entry);
            }
          }
        }

        for (const providerRaw of manifest.contributions.aiAgentProviders as Array<Record<string, unknown>>) {
          const providerId =
            typeof providerRaw?.id === 'string' ? providerRaw.id : '?';
          const backendModuleId =
            typeof providerRaw?.backendModuleId === 'string'
              ? providerRaw.backendModuleId
              : undefined;
          if (!backendModuleId) {
            // Already reported by validateAgentProviders above; don't
            // duplicate the error here.
            continue;
          }
          const entryRel = moduleEntries.get(backendModuleId);
          if (!entryRel) {
            // Cross-reference error already reported by
            // validateAgentProviders; skip the bundle scan.
            continue;
          }
          const entryAbs = path.join(path.dirname(manifestPath), entryRel);
          if (!fs.existsSync(entryAbs)) {
            // The missing-file error is already raised by the backendModules
            // entry check above; don't pile on with a confusingly worded
            // duplicate. Skip the export scan.
            continue;
          }
          // We deliberately do a textual scan rather than executing the
          // module. The backend module is meant to run inside a privileged
          // worker; loading it inside the build script could trigger side
          // effects (open ports, spawn processes, write disk) that have no
          // business firing during `vite build`. A string check for the
          // known export shapes is enough to catch typos and forgotten
          // exports, which is the failure mode users actually hit.
          let entrySource: string;
          try {
            entrySource = fs.readFileSync(entryAbs, 'utf8');
          } catch (readErr) {
            errors.push(
              `aiAgentProviders[${providerId}].backendModuleId "${backendModuleId}" ` +
                `points at entry ${entryRel} which exists but could not be read (${String(readErr)}). ` +
                'The validator needs to scan the entry for an activate / createAgentProvider export.'
            );
            continue;
          }
          // Look for either a top-level `export function activate` /
          // `export const activate` / `export { activate }`, or the same
          // shapes for `createAgentProvider`. Bundlers normalize these in
          // varied ways; the union of these patterns covers Vite, esbuild,
          // and tsc output. We do NOT match `exports.activate =` because
          // backend modules ship as ESM; CJS output would have been flagged
          // by the `require(` check earlier in this function anyway.
          const exportPatterns = [
            /export\s+(?:async\s+)?function\s+activate\b/,
            /export\s+(?:const|let|var)\s+activate\b/,
            /export\s*\{[^}]*\bactivate\b[^}]*\}/,
            /export\s+(?:async\s+)?function\s+createAgentProvider\b/,
            /export\s+(?:const|let|var)\s+createAgentProvider\b/,
            /export\s*\{[^}]*\bcreateAgentProvider\b[^}]*\}/,
          ];
          const hasExport = exportPatterns.some((p) => p.test(entrySource));
          if (!hasExport) {
            errors.push(
              `aiAgentProviders[${providerId}].backendModuleId "${backendModuleId}" ` +
                `resolves to ${entryRel}, but the entry file does not appear to export ` +
                'an `activate` or `createAgentProvider` function. The privileged host calls one ' +
                'of these to bring the provider online.'
            );
          }
        }
      }
    } catch (e) {
      errors.push(`Failed to parse manifest.json: ${e}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Prints validation results to console with formatting.
 */
export function printValidationResult(result: ValidationResult): void {
  if (result.valid && result.warnings.length === 0) {
    console.log('\x1b[32m%s\x1b[0m', '  Extension bundle validation passed');
    return;
  }

  if (result.errors.length > 0) {
    console.log('\x1b[31m%s\x1b[0m', '  Validation FAILED:');
    for (const error of result.errors) {
      console.log('\x1b[31m%s\x1b[0m', `    - ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\x1b[33m%s\x1b[0m', '  Warnings:');
    for (const warning of result.warnings) {
      console.log('\x1b[33m%s\x1b[0m', `    - ${warning}`);
    }
  }
}
