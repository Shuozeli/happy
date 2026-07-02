import { basename } from 'node:path';
import { decodeBase64, decrypt, decryptBoxBundle, deriveContentKeyPair } from './crypto.js';
import { readPersistedSessions, readAgentSecret } from './config.js';
import { HappyClient } from './HappyClient.js';
import type { SessionSnapshot, RawSession } from './types.js';

function formatRelativeTime(lastSeq: number, savedAt?: number): string {
    if (!savedAt) return 'unknown time ago';
    const diffMs = Date.now() - savedAt;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
    return `${Math.floor(diffHr / 24)} day${Math.floor(diffHr / 24) === 1 ? '' : 's'} ago`;
}

export class SessionMonitor {
    constructor(private readonly client: HappyClient) {}

    async listActive(): Promise<SessionSnapshot[]> {
        const localSessions = readPersistedSessions();
        const agentSecret = readAgentSecret();
        const contentKeyPair = agentSecret ? deriveContentKeyPair(agentSecret) : null;

        let rawSessions: RawSession[] = [];
        try {
            rawSessions = await this.client.listSessions();
        } catch (err) {
            console.error('[SessionMonitor] Failed to fetch sessions from server:', err);
        }

        const snapshots: SessionSnapshot[] = [];

        for (const raw of rawSessions) {
            if (!raw.active) continue;

            let encryptionKey: Uint8Array | null = null;
            let encryptionVariant: 'legacy' | 'dataKey' = 'legacy';

            // Try local persisted sessions first (fastest, always available)
            const local = localSessions[raw.id];
            if (local) {
                encryptionKey = decodeBase64(local.encryptionKey);
                encryptionVariant = local.encryptionVariant;
            } else if (raw.dataEncryptionKey && contentKeyPair) {
                // Unwrap session data key using content key pair from agent.key
                const bundle = decodeBase64(raw.dataEncryptionKey);
                const sessionKey = decryptBoxBundle(bundle.slice(1), contentKeyPair.secretKey);
                if (sessionKey) {
                    encryptionKey = sessionKey;
                    encryptionVariant = 'dataKey';
                }
            }

            if (!encryptionKey) continue; // Can't decrypt — skip

            const metadata = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata));
            if (!metadata || typeof metadata !== 'object') continue;

            const meta = metadata as Record<string, unknown>;
            const lifecycleState = typeof meta.lifecycleState === 'string' ? meta.lifecycleState : 'running';
            if (lifecycleState === 'archived' || lifecycleState === 'archiveRequested') continue;

            const summary = meta.summary && typeof meta.summary === 'object'
                ? (meta.summary as { text?: string }).text ?? null
                : null;

            snapshots.push({
                id: raw.id,
                directory: typeof meta.path === 'string' ? meta.path : '(unknown)',
                agentType: typeof meta.flavor === 'string' ? meta.flavor : 'claude',
                status: lifecycleState,
                summary,
                lastSeq: raw.seq,
                encryptionKey,
                encryptionVariant,
            });
        }

        return snapshots;
    }

    // Returns the best-matching session for a free-text query, or null if nothing scores.
    // Scoring: directory basename > full path > summary text. Multi-word queries score each word.
    findByQuery(sessions: SessionSnapshot[], query: string): SessionSnapshot | null {
        const words = query.toLowerCase().trim().split(/\s+/).filter((w) => w.length > 1);
        if (words.length === 0) return null;

        const scored = sessions.map((s) => {
            const dir = s.directory.toLowerCase();
            const dirBase = basename(dir);
            const summary = (s.summary ?? '').toLowerCase();
            let score = 0;

            for (const word of words) {
                if (dirBase.includes(word)) score += 3;
                else if (dir.includes(word)) score += 2;
                if (summary.includes(word)) score += 1;
            }

            return { session: s, score };
        });

        const best = scored.sort((a, b) => b.score - a.score)[0];
        return best && best.score > 0 ? best.session : null;
    }

    formatSessionList(sessions: SessionSnapshot[]): string {
        if (sessions.length === 0) {
            return 'You have no active coding sessions right now.';
        }

        const lines = sessions.map((s, i) => {
            const dir = s.directory.replace(process.env.HOME ?? '/root', '~');
            const type = s.agentType;
            const status = s.status === 'running' ? 'running' : s.status;
            return `Session ${i + 1}: ${dir}, ${type}, ${status}.`;
        });

        return `You have ${sessions.length} active session${sessions.length === 1 ? '' : 's'}. ${lines.join(' ')}`;
    }
}
