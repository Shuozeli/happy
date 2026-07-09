import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './schema.js';

// ── Row types (mirror the SQL schema exactly) ──────────────────────────────

export type IdentityRow = {
    id: 1;
    session_id: string;
    session_tag: string;
    encryption_key: string;     // base64
    encryption_variant: string; // 'legacy' | 'dataKey'
    seq: number;
    metadata_version: number;
    updated_at: number;
};

export type SessionRow = {
    id: string;
    directory: string;
    agent_type: string;
    lifecycle_state: string;
    encryption_key: string;     // base64
    encryption_variant: string;
    seq: number;
    summary_text: string | null;
    first_seen_at: number;
    last_seen_at: number;
    is_active: number;          // 1 | 0
};

export type ConversationRow = {
    id: number;
    role: string;               // 'user' | 'conductor'
    text: string;
    referenced_session_id: string | null;
    timestamp: number;
};

export type ActionLogRow = {
    id: number;
    action_type: string;
    session_id: string | null;
    payload: string | null;     // JSON string
    outcome: string | null;     // 'ok' | 'error: ...'
    timestamp: number;
};

const CONVERSATION_MAX_ROWS = 50;

// ── Database ────────────────────────────────────────────────────────────────

export class Database {
    private readonly db: BetterSqlite3.Database;

    constructor(path: string) {
        this.db = new BetterSqlite3(path);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        runMigrations(this.db);
    }

    // ── Identity ─────────────────────────────────────────────────────────

    getConductorIdentity(): IdentityRow | null {
        return (
            (this.db.prepare('SELECT * FROM conductor_identity WHERE id = 1').get() as IdentityRow | undefined) ?? null
        );
    }

    upsertConductorIdentity(row: Omit<IdentityRow, 'id'>): void {
        this.db
            .prepare(`
                INSERT INTO conductor_identity
                    (id, session_id, session_tag, encryption_key, encryption_variant, seq, metadata_version, updated_at)
                VALUES (1, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    session_id         = excluded.session_id,
                    session_tag        = excluded.session_tag,
                    encryption_key     = excluded.encryption_key,
                    encryption_variant = excluded.encryption_variant,
                    seq                = excluded.seq,
                    metadata_version   = excluded.metadata_version,
                    updated_at         = excluded.updated_at
            `)
            .run(
                row.session_id,
                row.session_tag,
                row.encryption_key,
                row.encryption_variant,
                row.seq,
                row.metadata_version,
                row.updated_at,
            );
    }

    updateIdentitySeq(seq: number): void {
        this.db
            .prepare('UPDATE conductor_identity SET seq = ?, updated_at = ? WHERE id = 1')
            .run(seq, Date.now());
    }

    updateIdentityMetadataVersion(version: number): void {
        this.db
            .prepare('UPDATE conductor_identity SET metadata_version = ?, updated_at = ? WHERE id = 1')
            .run(version, Date.now());
    }

    // ── Sessions ──────────────────────────────────────────────────────────

    getAllActiveSessions(): SessionRow[] {
        return this.db
            .prepare('SELECT * FROM sessions WHERE is_active = 1 ORDER BY first_seen_at ASC')
            .all() as SessionRow[];
    }

    getSession(id: string): SessionRow | null {
        return (
            (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null
        );
    }

    upsertSession(row: Omit<SessionRow, 'first_seen_at'> & { first_seen_at?: number }): void {
        const now = Date.now();
        this.db
            .prepare(`
                INSERT INTO sessions
                    (id, directory, agent_type, lifecycle_state, encryption_key, encryption_variant,
                     seq, summary_text, first_seen_at, last_seen_at, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    directory          = excluded.directory,
                    agent_type         = excluded.agent_type,
                    lifecycle_state    = excluded.lifecycle_state,
                    encryption_key     = excluded.encryption_key,
                    encryption_variant = excluded.encryption_variant,
                    seq                = excluded.seq,
                    summary_text       = COALESCE(excluded.summary_text, sessions.summary_text),
                    last_seen_at       = excluded.last_seen_at,
                    is_active          = excluded.is_active
            `)
            .run(
                row.id,
                row.directory,
                row.agent_type,
                row.lifecycle_state,
                row.encryption_key,
                row.encryption_variant,
                row.seq,
                row.summary_text ?? null,
                row.first_seen_at ?? now,
                row.last_seen_at,
                row.is_active,
            );
    }

    markSessionInactive(id: string): void {
        this.db
            .prepare('UPDATE sessions SET is_active = 0, last_seen_at = ? WHERE id = ?')
            .run(Date.now(), id);
    }

    updateSessionSummary(id: string, summaryText: string): void {
        this.db
            .prepare('UPDATE sessions SET summary_text = ?, last_seen_at = ? WHERE id = ?')
            .run(summaryText, Date.now(), id);
    }

    // ── Conversation ──────────────────────────────────────────────────────

    getRecentConversation(limit: number): ConversationRow[] {
        // Fetch last N rows in ascending order so LLM sees them chronologically.
        return this.db
            .prepare(`
                SELECT * FROM conversation
                ORDER BY id DESC
                LIMIT ?
            `)
            .all(limit) as ConversationRow[];
    }

    appendConversation(
        role: 'user' | 'conductor',
        text: string,
        referencedSessionId: string | null,
    ): void {
        this.db
            .prepare(
                'INSERT INTO conversation (role, text, referenced_session_id, timestamp) VALUES (?, ?, ?, ?)',
            )
            .run(role, text, referencedSessionId, Date.now());

        // Keep the table bounded — delete oldest rows beyond the cap.
        this.db.prepare(`
            DELETE FROM conversation WHERE id IN (
                SELECT id FROM conversation ORDER BY id DESC LIMIT -1 OFFSET ?
            )
        `).run(CONVERSATION_MAX_ROWS);
    }

    // ── Action log ────────────────────────────────────────────────────────

    logAction(
        actionType: string,
        sessionId: string | null,
        payload: unknown,
        outcome: 'ok' | `error: ${string}`,
    ): void {
        this.db
            .prepare(
                'INSERT INTO action_log (action_type, session_id, payload, outcome, timestamp) VALUES (?, ?, ?, ?, ?)',
            )
            .run(
                actionType,
                sessionId,
                payload !== null && payload !== undefined ? JSON.stringify(payload) : null,
                outcome,
                Date.now(),
            );
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    close(): void {
        this.db.close();
    }
}
