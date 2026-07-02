import axios from 'axios';
import { randomUUID } from 'node:crypto';
import {
    encodeBase64,
    decodeBase64,
    encrypt,
    getRandomBytes,
    libsodiumEncryptForPublicKey,
    decrypt,
} from './crypto.js';
import type { Credentials, RawSession, SessionMetadata } from './types.js';

const CLIENT_HEADER = 'conductor/0.1.0';

export type Session = {
    id: string;
    seq: number;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    metadata: SessionMetadata;
    metadataVersion: number;
};

export class HappyClient {
    private readonly headers: Record<string, string>;

    constructor(
        private readonly serverUrl: string,
        private readonly credentials: Credentials,
    ) {
        this.headers = {
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': CLIENT_HEADER,
        };
    }

    async getOrCreateSession(tag: string, metadata: SessionMetadata): Promise<Session> {
        let encryptionKey: Uint8Array;
        let encryptionVariant: 'legacy' | 'dataKey';
        let dataEncryptionKey: string | null = null;

        if (this.credentials.encryption.type === 'dataKey') {
            encryptionKey = getRandomBytes(32);
            encryptionVariant = 'dataKey';
            const wrapped = libsodiumEncryptForPublicKey(encryptionKey, this.credentials.encryption.publicKey);
            const bundle = new Uint8Array(1 + wrapped.length);
            bundle[0] = 0;
            bundle.set(wrapped, 1);
            dataEncryptionKey = encodeBase64(bundle);
        } else {
            encryptionKey = this.credentials.encryption.secret;
            encryptionVariant = 'legacy';
        }

        const response = await axios.post<{ session: { id: string; seq: number; metadata: string; metadataVersion: number; agentState: string | null; agentStateVersion: number } }>(
            `${this.serverUrl}/v1/sessions`,
            {
                tag,
                metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, metadata)),
                agentState: null,
                dataEncryptionKey,
            },
            { headers: this.headers, timeout: 60000 },
        );

        const raw = response.data.session;
        return {
            id: raw.id,
            seq: raw.seq,
            encryptionKey,
            encryptionVariant,
            metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) as SessionMetadata,
            metadataVersion: raw.metadataVersion,
        };
    }

    async listSessions(): Promise<RawSession[]> {
        const response = await axios.get<{ sessions: RawSession[] }>(
            `${this.serverUrl}/v1/sessions`,
            { headers: this.headers, timeout: 30000 },
        );
        return response.data.sessions ?? [];
    }

    async fetchMessages(
        sessionId: string,
        afterSeq: number,
        limit = 100,
    ): Promise<Array<{ id: string; seq: number; content: { t: string; c: string }; createdAt: number }>> {
        const response = await axios.get<{
            messages: Array<{ id: string; seq: number; content: { t: string; c: string }; createdAt: number }>;
            hasMore: boolean;
        }>(
            `${this.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
            {
                params: { after_seq: afterSeq, limit },
                headers: this.headers,
                timeout: 30000,
            },
        );
        return response.data.messages ?? [];
    }

    async sendMessages(
        sessionId: string,
        encryptionKey: Uint8Array,
        encryptionVariant: 'legacy' | 'dataKey',
        messages: unknown[],
    ): Promise<void> {
        const batch = messages.map((msg) => ({
            content: encodeBase64(encrypt(encryptionKey, encryptionVariant, msg)),
            localId: randomUUID(),
        }));
        await axios.post(
            `${this.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
            { messages: batch },
            { headers: this.headers, timeout: 30000 },
        );
    }

    async getVendorToken(vendor: 'anthropic' | 'openai' | 'gemini'): Promise<Record<string, unknown> | null> {
        try {
            const response = await axios.get<Record<string, unknown>>(
                `${this.serverUrl}/v1/connect/${vendor}/token`,
                { headers: this.headers, timeout: 5000 },
            );
            return response.data ?? null;
        } catch {
            return null;
        }
    }

    async spawnSessionViaDaemon(directory: string, daemonPort: number): Promise<void> {
        await axios.post(
            `http://127.0.0.1:${daemonPort}/spawn-session`,
            { directory },
            { timeout: 30000 },
        );
    }
}
