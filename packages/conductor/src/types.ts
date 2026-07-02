export type EncryptionVariant = 'legacy' | 'dataKey';

export type Credentials = {
    token: string;
    encryption:
        | { type: 'legacy'; secret: Uint8Array }
        | { type: 'dataKey'; publicKey: Uint8Array; machineKey: Uint8Array };
};

export type ConductorState = {
    sessionId: string;
    encryptionKey: string; // base64
    encryptionVariant: EncryptionVariant;
    seq: number;
};

export type PersistedSession = {
    encryptionKey: string; // base64
    encryptionVariant: EncryptionVariant;
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
    metadata: SessionMetadata;
    savedAt: number;
};

export type SessionMetadata = {
    path?: string;
    host?: string;
    flavor?: string;
    name?: string;
    lifecycleState?: string;
    summary?: { text: string; updatedAt: number };
    homeDir?: string;
    happyHomeDir?: string;
    happyLibDir?: string;
    happyToolsDir?: string;
    hostPid?: number;
    [key: string]: unknown;
};

export type RawSession = {
    id: string;
    active: boolean;
    metadata: string; // base64 encrypted
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    seq: number;
    dataEncryptionKey: string | null;
};

export type SessionSnapshot = {
    id: string;
    directory: string;
    agentType: string;
    status: string;
    summary: string | null;
    lastSeq: number;
    encryptionKey: Uint8Array;
    encryptionVariant: EncryptionVariant;
};

export type UserMessage = {
    role: 'user';
    content: { type: 'text'; text: string };
    localKey?: string;
};
