// The part of the vendored NATS client (`_events-bridge-nats.mjs`, @nats-io/nats-core 3.4.0) that events-bridge.ts
// uses, for the type check only. The names and shapes are the package's own (its `lib/core.d.ts`).

/** A status message's headers: a pull that expired is `code` 408, a consumer that went is 409 or 404. */
export interface MsgHdrs {
    readonly hasError: boolean;
    readonly code: number;
    readonly description: string;
    get(key: string): string;
}

export interface Msg {
    readonly subject: string;
    /** The JetStream ack subject of a message that a pull delivered. */
    readonly reply: string;
    readonly data: Uint8Array;
    readonly headers?: MsgHdrs;
}

export interface NatsConnection {
    request(
        subject: string,
        payload?: string | Uint8Array,
        opts?: { timeout: number },
    ): Promise<Msg>;
    publish(subject: string, payload?: string | Uint8Array): void;
    flush(): Promise<void>;
    close(): Promise<void>;
    closed(): Promise<void | Error>;
    isClosed(): boolean;
}

export interface ConnectionOptions {
    servers: string | string[];
    token?: string;
    inboxPrefix?: string;
    name?: string;
    reconnect?: boolean;
    timeout?: number;
    noEcho?: boolean;
    pingInterval?: number;
    maxPingOut?: number;
    ignoreClusterUpdates?: boolean;
}

export declare function wsconnect(options: ConnectionOptions): Promise<NatsConnection>;

export declare class AuthorizationError extends Error {}
export declare class ClosedConnectionError extends Error {}
export declare class ConnectionError extends Error {}
export declare class NoRespondersError extends Error {}
export declare class PermissionViolationError extends Error {}
export declare class RequestError extends Error {}
export declare class TimeoutError extends Error {}
