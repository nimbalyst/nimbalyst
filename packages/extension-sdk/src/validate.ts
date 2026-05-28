/**
 * Build-time validation for extension bundles.
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateBackendModules } from './manifestValidation.js';
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
