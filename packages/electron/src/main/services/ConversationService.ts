import {
  ConversationSync,
  type ConversationAppendInput,
  type ConversationHistoryPage,
  type ConversationSyncEvent,
  type ConversationTarget,
  type TeamJwt,
} from "@nimbalyst/runtime";
import type { ConversationSubscription } from "@nimbalyst/collab-protocol";

import { getCollabSyncHttpUrl } from "../utils/collabSyncUrl";
import { getOrgScopedJwt } from "./TeamService";

export type ConversationServiceEvent = ConversationTarget & {
  event: ConversationSyncEvent;
};

export interface ConversationServiceDependencies {
  getTeamJwt: (orgId: string) => Promise<TeamJwt>;
  getServerUrl: () => string;
  createSync?: (
    target: ConversationTarget,
    getTeamJwt: () => Promise<TeamJwt>
  ) => ConversationSync;
}

/**
 * Main-process owner for ConversationRoom connections.
 *
 * Every connection is keyed by organization and conversation and obtains its
 * JWT through the organization-scoped team resolver. The renderer receives
 * only protocol events and never handles credentials or sockets.
 */
export class ConversationService {
  private readonly dependencies: ConversationServiceDependencies;
  private readonly clients = new Map<string, ConversationSync>();
  private readonly cleanups = new Map<string, () => void>();
  private readonly listeners = new Set<
    (event: ConversationServiceEvent) => void
  >();

  constructor(dependencies: ConversationServiceDependencies) {
    this.dependencies = dependencies;
  }

  subscribe(listener: (event: ConversationServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async list(
    target: ConversationTarget,
    cursor?: string,
    pageSize?: number
  ): Promise<ConversationHistoryPage> {
    const sync = await this.ensureSync(target);
    return sync.list(cursor, pageSize);
  }

  async append(target: ConversationTarget, input: ConversationAppendInput) {
    const sync = await this.ensureSync(target);
    return sync.append(input);
  }

  async setSubscription(
    target: ConversationTarget,
    state: ConversationSubscription["state"],
    notificationLevel: ConversationSubscription["notificationLevel"]
  ): Promise<ConversationSubscription> {
    const sync = await this.ensureSync(target);
    return sync.setSubscription(state, notificationLevel);
  }

  destroy(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
    this.listeners.clear();
  }

  private async ensureSync(
    target: ConversationTarget
  ): Promise<ConversationSync> {
    const key = targetKey(target);
    const existing = this.clients.get(key);
    if (existing) {
      await existing.connect();
      return existing;
    }

    const getTeamJwt = () => this.dependencies.getTeamJwt(target.orgId);
    const sync = this.dependencies.createSync
      ? this.dependencies.createSync(target, getTeamJwt)
      : new ConversationSync({
          serverUrl: this.dependencies.getServerUrl(),
          target,
          getTeamJwt,
        });
    this.clients.set(key, sync);
    let hasConnected = false;
    this.cleanups.set(
      key,
      sync.subscribe((event) => {
        if (event.type === "connected") {
          hasConnected = true;
        } else if (event.type === "disconnected" && !hasConnected) {
          this.cleanups.get(key)?.();
          this.cleanups.delete(key);
          if (this.clients.get(key) === sync) {
            this.clients.delete(key);
            sync.destroy();
          }
        }
        const payload = { ...target, event };
        for (const listener of this.listeners) listener(payload);
      })
    );
    try {
      await sync.connect();
      return sync;
    } catch (error) {
      this.cleanups.get(key)?.();
      this.cleanups.delete(key);
      this.clients.delete(key);
      sync.destroy();
      throw error;
    }
  }
}

function targetKey(target: ConversationTarget): string {
  return JSON.stringify([target.orgId, target.conversationId]);
}

let service: ConversationService | null = null;

export function getConversationService(): ConversationService {
  if (!service) {
    service = new ConversationService({
      getTeamJwt: (orgId) => getOrgScopedJwt(orgId),
      getServerUrl: getCollabSyncHttpUrl,
    });
  }
  return service;
}

export function shutdownConversationService(): void {
  service?.destroy();
  service = null;
}
