import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeBase64 } from './crypto.js';
import type { Credentials, ConductorState, PersistedSession } from './types.js';

function happyHomeDir(): string {
    const env = process.env.HAPPY_HOME_DIR;
    if (env) return env.replace(/^~/, homedir());
    return join(homedir(), '.happy');
}

export function getPaths() {
    const home = happyHomeDir();
    return {
        home,
        accessKey: join(home, 'access.key'),
        agentKey: join(home, 'agent.key'),
        settings: join(home, 'settings.json'),
        sessions: join(home, 'sessions.json'),
        daemonState: join(home, 'daemon.state.json'),
        conductorState: join(home, 'conductor.state.json'),
        logs: join(home, 'logs'),
    };
}

export function readServerUrl(): string {
    const paths = getPaths();
    try {
        if (existsSync(paths.settings)) {
            const raw = JSON.parse(readFileSync(paths.settings, 'utf8'));
            if (typeof raw.serverUrl === 'string' && raw.serverUrl) return raw.serverUrl;
        }
    } catch { /* ignore */ }
    return process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com';
}

export function readMachineId(): string | null {
    const paths = getPaths();
    try {
        if (existsSync(paths.settings)) {
            const raw = JSON.parse(readFileSync(paths.settings, 'utf8'));
            if (typeof raw.machineId === 'string') return raw.machineId;
        }
    } catch { /* ignore */ }
    return null;
}

export function readCredentials(): Credentials | null {
    const paths = getPaths();
    try {
        if (!existsSync(paths.accessKey)) return null;
        const raw = JSON.parse(readFileSync(paths.accessKey, 'utf8'));
        if (raw.secret && typeof raw.token === 'string') {
            return {
                token: raw.token,
                encryption: { type: 'legacy', secret: decodeBase64(raw.secret) },
            };
        }
        if (raw.encryption && typeof raw.token === 'string') {
            return {
                token: raw.token,
                encryption: {
                    type: 'dataKey',
                    publicKey: decodeBase64(raw.encryption.publicKey),
                    machineKey: decodeBase64(raw.encryption.machineKey),
                },
            };
        }
    } catch { /* ignore */ }
    return null;
}

// Returns master secret from agent.key for deriving content key pair
export function readAgentSecret(): Uint8Array | null {
    const paths = getPaths();
    try {
        if (!existsSync(paths.agentKey)) return null;
        const raw = JSON.parse(readFileSync(paths.agentKey, 'utf8'));
        if (typeof raw.secret === 'string') return decodeBase64(raw.secret);
    } catch { /* ignore */ }
    return null;
}

export function readPersistedSessions(): Record<string, PersistedSession> {
    const paths = getPaths();
    const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
    try {
        if (!existsSync(paths.sessions)) return {};
        const data = JSON.parse(readFileSync(paths.sessions, 'utf8'));
        if (!data?.sessions || typeof data.sessions !== 'object') return {};
        const now = Date.now();
        const sessions: Record<string, PersistedSession> = {};
        for (const [id, session] of Object.entries(data.sessions) as [string, PersistedSession][]) {
            if (now - session.savedAt < SESSION_MAX_AGE_MS) sessions[id] = session;
        }
        return sessions;
    } catch { /* ignore */ }
    return {};
}

export function readConductorState(): ConductorState | null {
    const paths = getPaths();
    try {
        if (!existsSync(paths.conductorState)) return null;
        return JSON.parse(readFileSync(paths.conductorState, 'utf8')) as ConductorState;
    } catch { /* ignore */ }
    return null;
}

export function writeConductorState(state: ConductorState): void {
    const paths = getPaths();
    if (!existsSync(paths.home)) mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.conductorState, JSON.stringify(state, null, 2), 'utf8');
}

export function readDaemonHttpPort(): number | null {
    const paths = getPaths();
    try {
        if (!existsSync(paths.daemonState)) return null;
        const raw = JSON.parse(readFileSync(paths.daemonState, 'utf8'));
        if (typeof raw.httpPort === 'number') return raw.httpPort;
    } catch { /* ignore */ }
    return null;
}
