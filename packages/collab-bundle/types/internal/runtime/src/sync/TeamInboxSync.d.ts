import type { ActivityRef, Actor, ConversationSubscription, InboxDelivery, InboxUnavailableDelivery, InboxWatermark, InboxWireDelivery, PresenceDesiredStatus, TeamPresenceMember } from '@nimbalyst/collab-protocol';
import { type TeamJwt, type TeamMemberId } from '../auth/jwtScopes';
export declare const DEFAULT_TEAM_INBOX_CONNECT_CONCURRENCY = 4;
export interface TeamInboxOrgDescriptor {
    orgId: string;
    orgName: string;
    teamMemberId: TeamMemberId;
}
/** Protocol wire types, re-exported under the names this module has always used. */
export type TeamInboxWatermark = InboxWatermark;
export type TeamInboxUnavailableDelivery = InboxUnavailableDelivery;
export type TeamInboxWireDelivery = InboxWireDelivery;
export type { PresenceDesiredStatus, TeamPresenceMember };
export interface TeamInboxMaterializedDelivery {
    id: string;
    teamMemberId: TeamMemberId;
    orgId: string;
    orgName: string;
    createdAt: number;
    readAt?: number;
    dismissedAt?: number;
    unavailable?: true;
    source?: InboxDelivery['source'];
    reason?: InboxDelivery['reason'];
    agentSessionIds?: string[];
    agentDispatchedSessionIds?: string[];
    agentDispatch?: InboxDelivery['agentDispatch'];
    agentWakePolicy?: string;
    agentWakeMetadata?: Record<string, unknown>;
    /**
     * Structured author of the source event. Optional for the same reason it is
     * optional on the protocol delivery: the server does not populate it yet.
     */
    actor?: Actor;
    preview?: InboxDelivery['preview'];
    subscription?: ConversationSubscription['state'];
    hasUnreadActivity: boolean;
}
export type TeamInboxOrgConnectionStatus = 'connecting' | 'ready' | 'offline' | 'messagingUnavailable';
export interface TeamInboxOrganizationState {
    orgId: string;
    orgName: string;
    status: TeamInboxOrgConnectionStatus;
    errorCode?: string;
    errorMessage?: string;
}
export interface TeamInboxSnapshot {
    status: 'loading' | 'ready' | 'offlineWithCache' | 'offlineWithoutCache' | 'reconnecting';
    deliveries: TeamInboxMaterializedDelivery[];
    organizations: TeamInboxOrganizationState[];
    presence?: Record<string, Record<string, TeamPresenceMember>>;
    lastSyncedAt?: number;
}
export type TeamInboxOrgEvent = {
    type: 'connecting';
} | {
    type: 'sync';
    deliveries: TeamInboxWireDelivery[];
    watermarks: TeamInboxWatermark[];
    subscriptions: ConversationSubscription[];
} | {
    type: 'delivery';
    delivery: TeamInboxWireDelivery;
} | {
    type: 'watermark';
    conversationId: string;
    sequence: number;
    updatedAt: number;
} | {
    type: 'subscription';
    subscription: ConversationSubscription;
} | {
    type: 'presenceRoster';
    members: TeamPresenceMember[];
} | {
    type: 'presenceDelta';
    member: TeamPresenceMember;
} | {
    type: 'markRead';
    deliveryIds: string[];
    readAt: number;
    unreadCount: number;
} | {
    type: 'dismiss';
    deliveryIds: string[];
    dismissedAt: number;
    unreadCount: number;
} | {
    type: 'agentDispatch';
    deliveryId: string;
    sessionId: string;
    dispatchedAt: number;
} | {
    type: 'disconnected';
} | {
    type: 'error';
    code: string;
    message: string;
};
export interface TeamInboxOrgClientLike {
    readonly org: TeamInboxOrgDescriptor;
    connect(): Promise<void>;
    markRead(deliveryIds: string[]): Promise<void>;
    dismiss(deliveryIds: string[]): Promise<void>;
    claimAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
    completeAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
    setPresenceStatus?(status: PresenceDesiredStatus): void;
    subscribe(listener: (event: TeamInboxOrgEvent) => void): () => void;
    destroy(): void;
}
export interface TeamInboxOrgClientConfig {
    serverUrl: string;
    org: TeamInboxOrgDescriptor;
    getTeamJwt: () => Promise<TeamJwt>;
    createWebSocket?: (url: string) => WebSocket;
    heartbeatIntervalMs?: number;
    getPresenceStatus?: () => PresenceDesiredStatus;
    now?: () => number;
    clientId?: string;
}
export declare class TeamInboxOrgClient implements TeamInboxOrgClientLike {
    readonly org: TeamInboxOrgDescriptor;
    private readonly config;
    private readonly listeners;
    private ws;
    private destroyed;
    private custodyBlocked;
    private reconnectAttempt;
    private reconnectTimer;
    private heartbeatTimer;
    private pendingMessages;
    private readonly clientId;
    private readonly pendingRequests;
    constructor(config: TeamInboxOrgClientConfig);
    connect(): Promise<void>;
    subscribe(listener: (event: TeamInboxOrgEvent) => void): () => void;
    markRead(deliveryIds: string[]): Promise<void>;
    dismiss(deliveryIds: string[]): Promise<void>;
    claimAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
    completeAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
    setPresenceStatus(status: PresenceDesiredStatus): void;
    destroy(): void;
    private handleMessage;
    private sendOrQueue;
    private sendAgentDispatchRequest;
    private rejectPendingRequests;
    private startHeartbeat;
    private stopHeartbeat;
    private sendPresenceHeartbeat;
    private emit;
    private scheduleReconnect;
}
export interface TeamInboxFanInConfig {
    createClient: (org: TeamInboxOrgDescriptor) => TeamInboxOrgClientLike;
    connectConcurrency?: number;
    now?: () => number;
    /**
     * Fires only for a newly accepted realtime delivery broadcast. Initial sync,
     * reconnect hydration, and duplicate broadcasts never reach this callback.
     */
    onDelivery?: (delivery: TeamInboxMaterializedDelivery) => void;
}
export declare class TeamInboxFanIn {
    private readonly config;
    private readonly clients;
    private readonly cleanups;
    private readonly orgStates;
    private readonly listeners;
    private snapshot;
    private lastSyncedAt;
    private destroyed;
    constructor(config: TeamInboxFanInConfig);
    start(organizations: TeamInboxOrgDescriptor[]): Promise<void>;
    getSnapshot: () => TeamInboxSnapshot;
    subscribe: (listener: () => void) => (() => void);
    markRead(deliveryIds: string[]): Promise<void>;
    dismiss(deliveryId: string): Promise<void>;
    claimAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
    completeAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
    destroy(): void;
    private applyEvent;
    private inferReceiptsFromReadDeliveries;
    private applyMarkRead;
    private rebuildSnapshot;
    private groupDeliveryIdsByOrg;
    private findDeliveryOrg;
    private destroyClients;
    setPresenceStatus(status: PresenceDesiredStatus): void;
}
export declare function isActivityRef(source: InboxDelivery['source']): source is ActivityRef;
