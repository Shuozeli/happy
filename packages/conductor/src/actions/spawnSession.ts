import { readDaemonHttpPort } from '../config.js';
import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';

export async function spawnSession(
    db: Database,
    client: HappyClient,
    directory: string,
): Promise<string> {
    const port = readDaemonHttpPort();
    if (!port) {
        throw new Error('Happy daemon is not running. Start it with "happy claude" first.');
    }

    await client.spawnSessionViaDaemon(directory, port);
    db.logAction('spawnSession', null, { directory }, 'ok');

    // The new session will appear in the DB on the next fetchSessions call.
    // Return the directory so the caller can confirm to the user.
    return directory;
}
