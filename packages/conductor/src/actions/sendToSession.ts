import { decodeBase64 } from '../crypto.js';
import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';

export async function sendToSession(
    db: Database,
    client: HappyClient,
    sessionId: string,
    message: string,
): Promise<void> {
    const session = db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found in local registry`);

    const encryptionKey = decodeBase64(session.encryption_key);
    const encryptionVariant = session.encryption_variant as 'legacy' | 'dataKey';

    const userMessage = {
        role: 'user',
        content: { type: 'text', text: message },
    };

    await client.sendMessages(sessionId, encryptionKey, encryptionVariant, [userMessage]);
    db.logAction('sendToSession', sessionId, { message }, 'ok');
}
