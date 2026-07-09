import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';
import { fetchSessions } from './fetchSessions.js';
import { sendToSession } from './sendToSession.js';
import { interrupt } from './interrupt.js';
import { grantAccess } from './grantAccess.js';
import { summarizeSession } from './summarizeSession.js';
import { spawnSession } from './spawnSession.js';

export type Actions = {
    fetchSessions:    ()                                                       => Promise<void>;
    sendToSession:    (sessionId: string, message: string)                    => Promise<void>;
    interrupt:        (sessionId: string)                                      => Promise<void>;
    grantAccess:      (sessionId: string, requestId: string, allow: boolean)  => Promise<void>;
    summarizeSession: (sessionId: string)                                      => Promise<string>;
    spawnSession:     (directory: string)                                      => Promise<string>;
};

export function createActions(db: Database, client: HappyClient): Actions {
    return {
        fetchSessions:    ()                                    => fetchSessions(db, client),
        sendToSession:    (sessionId, message)                  => sendToSession(db, client, sessionId, message),
        interrupt:        (sessionId)                           => interrupt(db, client, sessionId),
        grantAccess:      (sessionId, requestId, allow)        => grantAccess(db, client, sessionId, requestId, allow),
        summarizeSession: (sessionId)                           => summarizeSession(db, client, sessionId),
        spawnSession:     (directory)                           => spawnSession(db, client, directory),
    };
}

export { fetchSessions, sendToSession, interrupt, grantAccess, summarizeSession, spawnSession };
