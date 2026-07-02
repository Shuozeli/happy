import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import {
    readCredentials,
    readMachineId,
    readServerUrl,
    readConductorState,
    writeConductorState,
    saveConductorSessionToSharedStore,
    readDaemonHttpPort,
    getPaths,
    readAgentSecret,
} from './config.js';
import { randomUUID } from 'node:crypto';
import { getRandomBytes, encodeBase64, decodeBase64, deriveContentKeyPair } from './crypto.js';
import { HappyClient } from './HappyClient.js';
import { ConductorSession } from './ConductorSession.js';
import { SessionMonitor } from './SessionMonitor.js';
import { SessionSummarizer } from './SessionSummarizer.js';
import { InterruptController } from './InterruptController.js';
import { parseIntent } from './CommandRouter.js';
import type { SessionMetadata } from './types.js';

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
    const agentSecret = readAgentSecret();
    const contentSecretKey = agentSecret ? deriveContentKeyPair(agentSecret).secretKey : undefined;

    const client = new HappyClient(serverUrl, credentials);
    const monitor = new SessionMonitor(client);
    const summarizer = new SessionSummarizer(client);
    const interruptor = new InterruptController(client);

    // Establish Conductor session — create fresh each start so key is stable
    let sessionId: string;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    let lastSeq: number;
    let sessionMetadata: SessionMetadata | undefined;
    let sessionMetadataVersion: number | undefined;

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

    const existingState = readConductorState();
    if (existingState) {
        console.log(`[Conductor] Resuming session ${existingState.sessionId}`);
        sessionId = existingState.sessionId;
        encryptionKey = decodeBase64(existingState.encryptionKey);
        encryptionVariant = existingState.encryptionVariant;
        lastSeq = existingState.seq;
        sessionMetadata = conductorMetadata;
    } else {
        // Use a unique tag so we always create a FRESH session when state is missing.
        // Reusing an old session tag without the original key causes dataEncryptionKey/metadata
        // mismatch — the server keeps the old wrapped key but we encrypt metadata with a new one.
        const tag = `conductor-v1-${machineId}-${randomUUID()}`;
        console.log(`[Conductor] Creating new session (tag=${tag})...`);
        const session = await client.getOrCreateSession(tag, conductorMetadata, contentSecretKey);
        sessionId = session.id;
        encryptionKey = session.encryptionKey;
        encryptionVariant = session.encryptionVariant;
        sessionMetadata = conductorMetadata;
        sessionMetadataVersion = session.metadataVersion;
        lastSeq = session.seq;

        const state: import('./types.js').ConductorState = {
            sessionId,
            sessionTag: tag,
            encryptionKey: encodeBase64(encryptionKey),
            encryptionVariant,
            seq: lastSeq,
        };
        writeConductorState(state);
        saveConductorSessionToSharedStore(sessionId, state, conductorMetadata);
        console.log(`[Conductor] Session created: ${sessionId}`);
    }

    const handleUserMessage = async (text: string): Promise<void> => {
        console.log(`[Conductor] Received: "${text}"`);
        const intent = parseIntent(text);
        console.log(`[Conductor] Intent: ${intent.type}`);

        let response: string;

        switch (intent.type) {
            case 'list-sessions': {
                const sessions = await monitor.listActive();
                response = monitor.formatSessionList(sessions);
                break;
            }

            case 'summarize-all': {
                const sessions = await monitor.listActive();
                if (sessions.length === 0) {
                    response = 'You have no active coding sessions right now.';
                } else if (sessions.length === 1) {
                    response = await summarizer.summarize(sessions[0]);
                } else {
                    const summaries = await Promise.all(
                        sessions.map(async (s, i) => {
                            const summary = await summarizer.summarize(s);
                            const dir = s.directory.replace(process.env.HOME ?? '/root', '~');
                            return `Session ${i + 1} in ${dir}: ${summary}`;
                        }),
                    );
                    response = summaries.join(' ');
                }
                break;
            }

            case 'summarize-one': {
                const sessions = await monitor.listActive();
                const idx = intent.sessionRef - 1;
                if (idx < 0 || idx >= sessions.length) {
                    response = `I don't see a session number ${intent.sessionRef}. You have ${sessions.length} active session${sessions.length === 1 ? '' : 's'}.`;
                } else {
                    response = await summarizer.summarize(sessions[idx]);
                }
                break;
            }

            case 'send-message':
            case 'interrupt': {
                const sessions = await monitor.listActive();
                const idx = intent.sessionRef - 1;
                if (idx < 0 || idx >= sessions.length) {
                    response = `I don't see a session number ${intent.sessionRef}.`;
                } else {
                    const target = sessions[idx];
                    const msg = intent.type === 'send-message' ? intent.message : intent.message;
                    await interruptor.sendMessage(target, msg);
                    const dir = target.directory.replace(process.env.HOME ?? '/root', '~');
                    response = `Done. I sent the message to session ${intent.sessionRef} in ${dir}.`;
                }
                break;
            }

            case 'find-and-summarize':
            case 'find-and-interrupt':
            case 'find-and-send': {
                const sessions = await monitor.listActive();
                const match = monitor.findByQuery(sessions, intent.query);
                if (!match) {
                    response = `I couldn't find an active session matching "${intent.query}". Try saying "list my sessions" to see what's running.`;
                } else {
                    const dir = match.directory.replace(process.env.HOME ?? '/root', '~');
                    if (intent.type === 'find-and-summarize') {
                        const summary = await summarizer.summarize(match);
                        response = `Found a session in ${dir}. ${summary}`;
                    } else {
                        const msg = intent.type === 'find-and-send' ? intent.message : intent.message;
                        await interruptor.sendMessage(match, msg);
                        response = `Found the session in ${dir} and sent your message.`;
                    }
                }
                break;
            }

            case 'spawn-session': {
                const port = readDaemonHttpPort();
                if (!port) {
                    response = 'The Happy daemon is not running. Start it with "happy claude" first.';
                } else {
                    await client.spawnSessionViaDaemon(intent.directory, port);
                    response = `Started a new session in ${intent.directory}.`;
                }
                break;
            }

            case 'help': {
                response = 'You can say: list my sessions, summarize session 1, what is session 2 doing, tell session 1 to stop, or start a new session in a directory.';
                break;
            }

            default: {
                response = 'I didn\'t understand that. Try saying "list my sessions", "summarize session 1", or "tell session 1 to stop".';
            }
        }

        console.log(`[Conductor] Responding: "${response.slice(0, 100)}${response.length > 100 ? '...' : ''}"`);
        await conductorSession.sendAgentMessage(response);
    };

    const conductorSession = new ConductorSession(
        serverUrl,
        credentials.token,
        sessionId,
        encryptionKey,
        encryptionVariant,
        client,
        lastSeq,
        handleUserMessage,
        sessionMetadata,
        sessionMetadataVersion,
    );

    conductorSession.connect();
    conductorSession.startPolling(3000); // Poll every 3s as fallback

    console.log(`[Conductor] Ready. Session ID: ${sessionId}`);
    console.log(`[Conductor] Open the Happy app and look for the "Conductor" session.`);

    // Keep process alive
    process.on('SIGINT', () => {
        console.log('\n[Conductor] Shutting down...');
        conductorSession.close();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        conductorSession.close();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('[Conductor] Fatal error:', err);
    process.exit(1);
});
