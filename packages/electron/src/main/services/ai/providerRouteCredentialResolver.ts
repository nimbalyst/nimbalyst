import fs from "fs";
import os from "os";
import path from "path";
import {
  CLAUDEX_INGRESS_CREDENTIAL_REF,
  OPENROUTER_API_CREDENTIAL_REF,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogDefaults";
import { getProviderApiKeyFromSettings } from "../../utils/store";

export interface ProviderRouteCredentialHostDeps {
  readTextFile(filePath: string): string | undefined;
  getProviderApiKey(providerId: string, workspacePath?: string): string | null;
  getClaudexRoot(): string;
}

function defaultClaudexRoot(): string {
  const configured = process.env.CLAUDEX_HOME?.trim();
  if (configured) return configured;
  return path.join("D:/Users", os.userInfo().username, "Claudex");
}

const DEFAULT_DEPS: ProviderRouteCredentialHostDeps = {
  readTextFile: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return undefined;
    }
  },
  getProviderApiKey: (providerId, workspacePath) =>
    getProviderApiKeyFromSettings(providerId, workspacePath),
  getClaudexRoot: defaultClaudexRoot,
};

/**
 * Resolve only the reviewed named references owned by the Electron host.
 * OpenRouter comes exclusively from explicit Nimbalyst provider settings;
 * Claudex uses its dedicated ACL-restricted ingress-token file. No process-env
 * API-key fallback, interactive auth, logging, or catalog value is permitted.
 */
export function createProviderRouteCredentialResolver(
  deps: Partial<ProviderRouteCredentialHostDeps> = {}
): (
  credentialRef: string,
  context?: Readonly<{ workspacePath?: string }>
) => string | undefined {
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  return (credentialRef, context) => {
    if (credentialRef === OPENROUTER_API_CREDENTIAL_REF) {
      return (
        resolvedDeps
          .getProviderApiKey("openrouter", context?.workspacePath)
          ?.trim() || undefined
      );
    }
    if (credentialRef === CLAUDEX_INGRESS_CREDENTIAL_REF) {
      const root = path.resolve(resolvedDeps.getClaudexRoot());
      const credentialPath = path.join(root, "secrets", "ingress.token");
      const value = resolvedDeps.readTextFile(credentialPath)?.trim();
      return value && value.length >= 40 ? value : undefined;
    }
    return undefined;
  };
}
