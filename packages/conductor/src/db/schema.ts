import type BetterSqlite3 from 'better-sqlite3';

const DDL = `
CREATE TABLE IF NOT EXISTS conductor_identity (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  session_id         TEXT    NOT NULL,
  session_tag        TEXT    NOT NULL,
  encryption_key     TEXT    NOT NULL,
  encryption_variant TEXT    NOT NULL,
  seq                INTEGER NOT NULL DEFAULT 0,
  metadata_version   INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT    PRIMARY KEY,
  directory          TEXT    NOT NULL,
  agent_type         TEXT    NOT NULL DEFAULT 'claude',
  lifecycle_state    TEXT    NOT NULL DEFAULT 'running',
  encryption_key     TEXT    NOT NULL,
  encryption_variant TEXT    NOT NULL,
  seq                INTEGER NOT NULL DEFAULT 0,
  summary_text       TEXT,
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  is_active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conversation (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  role                  TEXT    NOT NULL,
  text                  TEXT    NOT NULL,
  referenced_session_id TEXT,
  timestamp             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS action_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT    NOT NULL,
  session_id  TEXT,
  payload     TEXT,
  outcome     TEXT,
  timestamp   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

// Each migration is keyed by version number and runs exactly once.
const MIGRATIONS: Record<number, string> = {
    1: DDL,
};

export function runMigrations(db: BetterSqlite3.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
    `);

    const applied = new Set<number>(
        (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
            (r) => r.version,
        ),
    );

    const insert = db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );

    for (const [versionStr, sql] of Object.entries(MIGRATIONS)) {
        const version = Number(versionStr);
        if (applied.has(version)) continue;
        db.exec(sql);
        insert.run(version, Date.now());
    }
}
