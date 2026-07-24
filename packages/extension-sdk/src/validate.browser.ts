import type { ValidationResult } from './validationTypes.js';

const BROWSER_VALIDATION_ERROR =
  'validateExtensionBundle() is only available in Node.js build tooling. ' +
  'Import it from a Vite config, build script, or other Node runtime.';

export async function validateExtensionBundle(
  _distPath: string,
  _bundleName = 'index.js'
): Promise<ValidationResult> {
  return {
    valid: false,
    errors: [BROWSER_VALIDATION_ERROR],
    warnings: [],
  };
}

export function printValidationResult(result: ValidationResult): void {
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.warn(BROWSER_VALIDATION_ERROR);
    return;
  }

  if (result.errors.length > 0) {
    console.error('Extension bundle validation errors:');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.warn('Extension bundle validation warnings:');
    for (const warning of result.warnings) {
      console.warn(`  - ${warning}`);
    }
  }
}

export type { ValidationResult } from './validationTypes.js';
