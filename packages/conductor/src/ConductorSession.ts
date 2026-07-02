import { io, Socket } from 'socket.io-client';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './crypto.js';
import { HappyClient } from './HappyClient.js';
import type { SessionMetadata, UserMessage } from './types.js';

type ServerToClientEvents = {
    update: (data: { body: { t: string; sid?: string; message?: { seq: number; content: { t: string; c: string } } } }) => void;
    auth: (data: { success: boolean }) => void;
    error: (data: { message: string }) => void;
};

type ClientToServerEvents = {
    'session-alive': (data: { sid: string; time: number; thinking: boolean; mode: string }) => void;
    'update-metadata': (data: { sid: string; expectedVersion: number; metadata: string }, cb: (res: unknown) => void) => void;
};

export class ConductorSession {
    private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly serverUrl: string,
        private readonly token: string,
        readonly sessionId: string,
        private readonly encryptionKey: Uint8Array,
        private readonly encryptionVariant: 'legacy' | 'dataKey',
        private readonly client: HappyClient,
        private lastSeq: number,
        private readonly onUserMessage: (text: string) => Promise<void>,
        private readonly metadata?: SessionMetadata,
        private metadataVersion?: number,
    ) {}

    connect(): void {
        this.socket = io(this.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped',
                sessionId: this.sessionId,
                happyClient: 'conductor/0.1.0',
            },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            autoConnect: false,
        }) as Socket<ServerToClientEvents, ClientToServerEvents>;

        this.socket.on('connect', () => {
            console.log('[Conductor] Socket connected');
            if (this.reconnectTimer) {
                clearInterval(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.startKeepAlive();
            this.pushMetadata().catch(() => {});
            // Fetch any messages missed while disconnected
            this.pollMessages().catch(() => {});
        });

        this.socket.on('update', (data) => {
            if (data.body?.t !== 'new-message' || !data.body.message) return;
            const msg = data.body.message;
            if (msg.content?.t !== 'encrypted') return;
            const seq = msg.seq;
            if (seq !== this.lastSeq + 1) {
                this.pollMessages().catch(() => {});
                return;
            }
            this.lastSeq = seq;
            const decoded = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(msg.content.c));
            if (decoded !== null) this.handleRawDecrypted(decoded);
        });

        this.socket.on('disconnect', () => {
            console.log('[Conductor] Socket disconnected, will reconnect...');
            this.stopKeepAlive();
            this.startSmartReconnect();
        });

        this.socket.on('connect_error', () => {
            this.startSmartReconnect();
        });

        this.socket.connect();
    }

    private handleRawDecrypted(body: unknown): void {
        if (!body || typeof body !== 'object') return;
        const msg = body as Record<string, unknown>;
        if (msg.role === 'user') {
            const content = msg.content as Record<string, unknown> | undefined;
            if (content?.type === 'text' && typeof content.text === 'string') {
                const userMsg: UserMessage = { role: 'user', content: { type: 'text', text: content.text } };
                this.onUserMessage(userMsg.content.text).catch((err) => {
                    console.error('[Conductor] Error handling user message:', err);
                });
            }
        }
    }

    private async pollMessages(): Promise<void> {
        try {
            const messages = await this.client.fetchMessages(this.sessionId, this.lastSeq, 50);
            for (const msg of messages) {
                if (msg.seq <= this.lastSeq) continue;
                if (msg.content?.t !== 'encrypted') continue;
                this.lastSeq = msg.seq;
                const decoded = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(msg.content.c));
                if (decoded === null) continue; // old messages from before key rotation — skip
                this.handleRawDecrypted(decoded);
            }
        } catch (err) {
            console.error('[Conductor] Poll error:', err);
        }
    }

    async sendAgentMessage(text: string): Promise<void> {
        const message = {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'claude',
                data: { type: 'message', message: text },
            },
            meta: { sentFrom: 'cli' },
        };
        await this.client.sendMessages(this.sessionId, this.encryptionKey, this.encryptionVariant, [message]);
    }

    private async pushMetadata(): Promise<void> {
        if (!this.metadata || !this.socket) return;
        const updated: SessionMetadata = {
            ...this.metadata,
            summary: { text: 'Conductor', updatedAt: Date.now() },
        };
        const encoded = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated));
        this.socket.emit('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion ?? 0, metadata: encoded }, (res: unknown) => {
            const r = res as Record<string, unknown> | null;
            if (r && typeof r === 'object' && 'version' in r && typeof r.version === 'number') {
                this.metadataVersion = r.version;
                console.log(`[Conductor] Metadata pushed, version=${r.version}`);
            } else {
                console.warn('[Conductor] pushMetadata unexpected response:', JSON.stringify(res));
            }
        });
    }

    private startKeepAlive(): void {
        this.stopKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            this.socket?.volatile.emit('session-alive', {
                sid: this.sessionId,
                time: Date.now(),
                thinking: false,
                mode: 'remote',
            });
        }, 20_000);
    }

    private stopKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private startSmartReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setInterval(() => {
            if (this.socket?.connected) {
                clearInterval(this.reconnectTimer!);
                this.reconnectTimer = null;
                return;
            }
            console.log('[Conductor] Attempting reconnect...');
            this.socket?.connect();
        }, 3000);
    }

    startPolling(intervalMs = 3000): void {
        setInterval(() => this.pollMessages(), intervalMs);
    }

    close(): void {
        this.stopKeepAlive();
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.socket?.close();
    }
}
