import { decodeBase64, decrypt, decryptBoxBundle, deriveContentKeyPair } from '../crypto.js';
import { readPersistedSessions, readAgentSecret } from '../config.js';
import type { Database, SessionRow } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';

export async function fetchSessions(db: Database, client: HappyClient): Promise<void> {
    const rawSessions = await client.listSessions();

    const localSessions = readPersistedSessions();
    const agentSecret = readAgentSecret();
    const contentKeyPair = agentSecret ? deriveContentKeyPair(agentSecret) : null;

    const seenIds = new Set<string>();

    for (const raw of rawSessions) {
        seenIds.add(raw.id);

        // Key resolution: DB first (fastest) → sessions.json → agent.key
        let encryptionKey: Uint8Array | null = null;
        let encryptionVariant: 'legacy' | 'dataKey' = 'dataKey';

        const existing = db.getSession(raw.id);
        if (existing) {
            encryptionKey = decodeBase64(existing.encryption_key);
            encryptionVariant = existing.encryption_variant as 'legacy' | 'dataKey';
        } else if (localSessions[raw.id]) {
            const local = localSessions[raw.id];
            encryptionKey = decodeBase64(local.encryptionKey);
            encryptionVariant = local.encryptionVariant;
        } else if (raw.dataEncryptionKey && contentKeyPair) {
            const bundle = decodeBase64(raw.dataEncryptionKey);
            const unwrapped = decryptBoxBundle(bundle.slice(1), contentKeyPair.secretKey);
            if (unwrapped) {
                encryptionKey = unwrapped;
                encryptionVariant = 'dataKey';
            }
        }

        if (!encryptionKey) continue; // Can't decrypt this session — skip

        const metadata = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata));
        if (!metadata || typeof metadata !== 'object') continue;

        const meta = metadata as Record<string, unknown>;
        const lifecycleState = typeof meta.lifecycleState === 'string' ? meta.lifecycleState : 'running';

        // Skip conductor's own session
        if (meta.flavor === 'conductor') continue;

        const summary =
            meta.summary && typeof meta.summary === 'object'
                ? ((meta.summary as { text?: string }).text ?? null)
                : null;

        const row: Omit<SessionRow, 'first_seen_at'> = {
            id: raw.id,
            directory: typeof meta.path === 'string' ? meta.path : '(unknown)',
            agent_type: typeof meta.flavor === 'string' ? meta.flavor : 'claude',
            lifecycle_state: lifecycleState,
            encryption_key: Buffer.from(encryptionKey).toString('base64'),
            encryption_variant: encryptionVariant,
            seq: raw.seq,
            summary_text: summary,
            last_seen_at: Date.now(),
            is_active: raw.active && lifecycleState !== 'archived' && lifecycleState !== 'archiveRequested' ? 1 : 0,
        };

        db.upsertSession(row);
    }

    // Mark sessions that disappeared from the server response as inactive
    for (const session of db.getAllActiveSessions()) {
        if (!seenIds.has(session.id)) {
            db.markSessionInactive(session.id);
        }
    }

    db.logAction('fetchSessions', null, { count: seenIds.size }, 'ok');
}
