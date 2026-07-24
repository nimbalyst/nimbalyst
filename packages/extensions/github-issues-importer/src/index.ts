/**
 * GitHub Issues Importer — renderer entry.
 *
 * This importer has no renderer surface in v1: authentication is handled by the
 * user's GitHub CLI (`gh`) and the import target (binding) is derived from the
 * workspace's GitHub git remote. All behaviour lives in the backend module
 * (see src/backend.ts). The manifest still requires a `main`, so this is an
 * inert module.
 */
export {};
