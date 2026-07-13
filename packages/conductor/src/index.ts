import { hostname, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
    readCredentials,
    readMachineId,
    readServerUrl,
    readConductorState,
    getPaths,
    readAgentSecret,
    saveConductorSessionToSharedStore,
} from './config.js';
import { encodeBase64, decodeBase64, deriveContentKeyPair } from './crypto.js';
import { HappyClient } from './HappyClient.js';
import { ConductorSession, type RpcHandler } from './ConductorSession.js';
import { Database } from './db/Database.js';
import { createActions } from './actions/index.js';
import { LLMTranslator } from './LLMTranslator.js';
import type { SessionMetadata } from './types.js';

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('[Conductor] Starting...');

    const credentials = readCredentials();
    if (!credentials) {
        console.error('[Conductor] No credentials found. Run `happy` first to authenticate.');
        process.exit(1);
    }

    const serverUrl = readServerUrl();
    const machineId = readMachineId() ?? 'default';
    const paths = getPaths();

    const db = new Database(paths.conductorDb);
    const client = new HappyClient(serverUrl, credentials);
    const actions = createActions(db, client);
    const llm = new LLMTranslator(client);

    // ── Identity: load from DB, migrate from old state file, or create fresh ──

    let sessionId: string;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    let lastSeq: number;
    let metadataVersion: number | undefined;

    const identity = db.getConductorIdentity();

    if (identity) {
        console.log(`[Conductor] Resuming session ${identity.session_id}`);
        sessionId = identity.session_id;
        encryptionKey = decodeBase64(identity.encryption_key);
        encryptionVariant = identity.encryption_variant as 'legacy' | 'dataKey';
        lastSeq = identity.seq;
        metadataVersion = identity.metadata_version;
    } else {
        // Attempt one-time migration from the legacy conductor.state.json
        const legacyState = readConductorState();

        if (legacyState) {
            console.log(`[Conductor] Migrating from conductor.state.json → conductor.db`);
            sessionId = legacyState.sessionId;
            encryptionKey = decodeBase64(legacyState.encryptionKey);
            encryptionVariant = legacyState.encryptionVariant;
            lastSeq = legacyState.seq;
        } else {
            const agentSecret = readAgentSecret();
            const contentSecretKey = agentSecret ? deriveContentKeyPair(agentSecret).secretKey : undefined;
            const tag = `conductor-v1-${machineId}-${randomUUID()}`;

            console.log(`[Conductor] Creating new session (tag=${tag})...`);

            const conductorMetadata: SessionMetadata = {
                path: homedir(),
                host: hostname(),
                flavor: 'conductor',
                name: 'Conductor',
                summary: { text: 'Conductor', updatedAt: Date.now() },
                homeDir: homedir(),
                happyHomeDir: paths.home,
                happyLibDir: '',
                happyToolsDir: '',
                lifecycleState: 'running',
                machineId,
            };

            const session = await client.getOrCreateSession(tag, conductorMetadata, contentSecretKey);
            sessionId = session.id;
            encryptionKey = session.encryptionKey;
            encryptionVariant = session.encryptionVariant;
            lastSeq = session.seq;
            metadataVersion = session.metadataVersion;

            // Also write to sessions.json so happy-cli can see the conductor session
            saveConductorSessionToSharedStore(
                sessionId,
                { sessionId, sessionTag: tag, encryptionKey: encodeBase64(encryptionKey), encryptionVariant, seq: lastSeq },
                conductorMetadata,
            );

            console.log(`[Conductor] Session created: ${sessionId}`);
        }

        const migratedTag = legacyState?.sessionTag ?? `conductor-v1-${machineId}-migrated`;
        db.upsertConductorIdentity({
            session_id: sessionId,
            session_tag: migratedTag,
            encryption_key: encodeBase64(encryptionKey),
            encryption_variant: encryptionVariant,
            seq: lastSeq,
            metadata_version: metadataVersion ?? 0,
            updated_at: Date.now(),
        });
    }

    // ── Conductor metadata (pushed on every connect) ─────────────────────────

    const conductorMetadata: SessionMetadata = {
        path: homedir(),
        host: hostname(),
        flavor: 'conductor',
        name: 'Conductor',
        summary: { text: 'Conductor', updatedAt: Date.now() },
        homeDir: homedir(),
        happyHomeDir: paths.home,
        happyLibDir: '',
        happyToolsDir: '',
        lifecycleState: 'running',
        machineId,
    };

    // ── Message handler ───────────────────────────────────────────────────────

    const handleUserMessage = async (text: string, seq: number): Promise<void> => {
        console.log(`[Conductor] Received: "${text}"`);

        // Always refresh the session registry so the LLM sees current state
        try {
            await actions.fetchSessions();
        } catch (err) {
            console.warn('[Conductor] fetchSessions failed (continuing with cached state):', err);
        }

        const sessions = db.getAllActiveSessions();
        const history = db.getRecentConversation(10);
        const plan = await llm.translate(text, sessions, history);

        console.log(`[Conductor] Plan: action=${plan.action} session=${plan.session_id ?? 'none'}`);

        let reply = plan.reply;

        try {
            switch (plan.action) {
                case 'fetch_sessions': {
                    // Already fetched above — build the reply from actual DB state.
                    const active = db.getAllActiveSessions();
                    if (active.length === 0) {
                        reply = 'You have no active sessions right now.';
                    } else {
                        const names = active.map((s, i) => {
                            const label = s.summary_text
                                ? s.summary_text.split('.')[0].slice(0, 80)
                                : s.directory.replace(process.env.HOME ?? '/root', '~');
                            return `${i + 1}. ${label}`;
                        }).join('; ');
                        reply = `You have ${active.length} active session${active.length > 1 ? 's' : ''}: ${names}.`;
                    }
                    break;
                }

                case 'send_to_session':
                    if (plan.session_id && plan.params?.message) {
                        await actions.sendToSession(plan.session_id, String(plan.params.message));
                    }
                    break;

                case 'interrupt':
                    if (plan.session_id) await actions.interrupt(plan.session_id);
                    break;

                case 'grant_access':
                    if (plan.session_id && plan.params?.requestId !== undefined) {
                        await actions.grantAccess(
                            plan.session_id,
                            String(plan.params.requestId),
                            Boolean(plan.params.allow),
                        );
                    }
                    break;

                case 'summarize_session':
                    if (plan.session_id) {
                        // The actual summary replaces the LLM's placeholder reply
                        reply = await actions.summarizeSession(plan.session_id);
                    }
                    break;

                case 'spawn_session':
                    if (plan.params?.directory) {
                        await actions.spawnSession(String(plan.params.directory));
                    }
                    break;

                case 'none':
                default:
                    break;
            }
        } catch (err) {
            console.error(`[Conductor] Action ${plan.action} failed:`, err);
            reply = `Sorry, I ran into a problem: ${err instanceof Error ? err.message : String(err)}`;
        }

        db.appendConversation('user', text, plan.session_id);
        db.appendConversation('conductor', reply, plan.session_id);
        db.updateIdentitySeq(seq);

        console.log(`[Conductor] Replying: "${reply.slice(0, 120)}${reply.length > 120 ? '...' : ''}"`);
        await conductorSession.sendAgentMessage(reply);
    };

    // ── RPC handler — lets HTTP callers invoke actions without the LLM router ──

    const handleRpc: RpcHandler = async (method, params) => {
        const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
        switch (method) {
            case 'fetch_sessions':
                await actions.fetchSessions();
                return db.getAllActiveSessions();
            case 'send_to_session':
                await actions.sendToSession(String(p.sessionId), String(p.message));
                return null;
            case 'interrupt':
                await actions.interrupt(String(p.sessionId));
                return null;
            case 'summarize_session':
                return actions.summarizeSession(String(p.sessionId));
            case 'spawn_session':
                return actions.spawnSession(String(p.directory));
            case 'grant_access':
                await actions.grantAccess(String(p.sessionId), String(p.requestId), Boolean(p.allow));
                return null;
            default:
                throw new Error(`Unknown RPC method: ${method}`);
        }
    };

    // ── Socket session ────────────────────────────────────────────────────────

    const conductorSession = new ConductorSession(
        serverUrl,
        credentials.token,
        sessionId,
        encryptionKey,
        encryptionVariant,
        client,
        lastSeq,
        (text) => handleUserMessage(text, lastSeq + 1),
        conductorMetadata,
        metadataVersion,
        handleRpc,
    );

    conductorSession.connect();
    conductorSession.startPolling(5000);

    console.log(`[Conductor] Ready. Session ID: ${sessionId}`);
    console.log(`[Conductor] Open the Happy app and look for the "Conductor" session.`);

    // ── Background session polling ────────────────────────────────────────────

    // Do an initial fetch so the DB is populated before any user message arrives.
    actions.fetchSessions().catch((err) => console.warn('[Conductor] Initial fetchSessions failed:', err));

    const POLL_INTERVAL_MS = 30_000;
    const pollTimer = setInterval(
        () => actions.fetchSessions().catch((err) => console.warn('[Conductor] Background fetchSessions failed:', err)),
        POLL_INTERVAL_MS,
    );

    // ── Graceful shutdown ─────────────────────────────────────────────────────

    const shutdown = (): void => {
        console.log('\n[Conductor] Shutting down...');
        clearInterval(pollTimer);
        conductorSession.close();
        db.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[Conductor] Fatal error:', err);
    process.exit(1);
});
