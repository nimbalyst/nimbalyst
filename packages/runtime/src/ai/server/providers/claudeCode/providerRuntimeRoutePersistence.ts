import { AISessionsRepository } from "../../../../storage/repositories/AISessionsRepository";
import {
  ProviderRuntimeRouteError,
  createProviderRuntimeSessionSnapshot,
  providerRuntimeRouteSnapshotEquals,
  type ClaudeAgentRuntimeRouteBundle,
  type ProviderRuntimeSessionSnapshot,
} from "./runtimeRouteResolver";

export const PROVIDER_RUNTIME_ROUTE_METADATA_KEY =
  "providerRuntimeRouteSnapshotV1" as const;

export interface DurableProviderRuntimeRouteSnapshot {
  schemaVersion: 1;
  main: Readonly<ProviderRuntimeSessionSnapshot>;
  subagent: Readonly<ProviderRuntimeSessionSnapshot>;
  consultation: Readonly<ProviderRuntimeSessionSnapshot>;
}

export interface ProviderRuntimeRoutePersistenceAdapter {
  installSessionMetadataValueIfAbsent(
    sessionId: string,
    key: string,
    value: unknown
  ): Promise<unknown>;
}

const DEFAULT_PERSISTENCE_ADAPTER: ProviderRuntimeRoutePersistenceAdapter = {
  installSessionMetadataValueIfAbsent: (sessionId, key, value) =>
    AISessionsRepository.installMetadataValueIfAbsent(sessionId, key, value),
};

function cloneAndFreeze<T>(value: T): Readonly<T> {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (candidate: unknown): void => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Object.isFrozen(candidate)
    ) {
      return;
    }
    Object.freeze(candidate);
    for (const nested of Object.values(candidate)) freeze(nested);
  };
  freeze(clone);
  return clone;
}

export function createDurableProviderRuntimeRouteSnapshot(
  routes: Readonly<ClaudeAgentRuntimeRouteBundle>
): Readonly<DurableProviderRuntimeRouteSnapshot> {
  return cloneAndFreeze({
    schemaVersion: 1 as const,
    main: createProviderRuntimeSessionSnapshot(routes.main),
    subagent: createProviderRuntimeSessionSnapshot(routes.subagent),
    consultation: createProviderRuntimeSessionSnapshot(routes.consultation),
  });
}

function assertExactDurableSnapshot(
  sessionId: string,
  current: Readonly<DurableProviderRuntimeRouteSnapshot>,
  persisted: unknown
): Readonly<DurableProviderRuntimeRouteSnapshot> {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !providerRuntimeRouteSnapshotEquals(persisted, current)
  ) {
    throw new ProviderRuntimeRouteError(
      "immutable-session-route",
      `Running session ${sessionId} already owns a different or invalid durable provider route.`,
      current.main.plan.model.catalogEntryId
    );
  }
  return cloneAndFreeze(
    persisted as DurableProviderRuntimeRouteSnapshot
  ) as Readonly<DurableProviderRuntimeRouteSnapshot>;
}

/**
 * Atomically install or hydrate the complete route bundle in existing session
 * metadata. The store returns the winning value from its compare-and-set loop,
 * so competing routes cannot both proceed. No credential value is accepted.
 */
export async function persistProviderRuntimeRouteSnapshot(
  sessionId: string,
  routes: Readonly<ClaudeAgentRuntimeRouteBundle>,
  adapter: ProviderRuntimeRoutePersistenceAdapter = DEFAULT_PERSISTENCE_ADAPTER
): Promise<Readonly<DurableProviderRuntimeRouteSnapshot>> {
  if (!sessionId) {
    throw new ProviderRuntimeRouteError(
      "immutable-session-route",
      "A durable provider route requires a stable session id.",
      routes.main.model.catalogEntryId
    );
  }
  const current = createDurableProviderRuntimeRouteSnapshot(routes);
  let persisted: unknown;
  try {
    persisted = await adapter.installSessionMetadataValueIfAbsent(
      sessionId,
      PROVIDER_RUNTIME_ROUTE_METADATA_KEY,
      current
    );
  } catch (error) {
    throw new ProviderRuntimeRouteError(
      "immutable-session-route",
      `Cannot atomically persist provider route for session ${sessionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      routes.main.model.catalogEntryId
    );
  }
  return assertExactDurableSnapshot(sessionId, current, persisted);
}
