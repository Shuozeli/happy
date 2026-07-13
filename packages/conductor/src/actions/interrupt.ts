import { decodeBase64 } from '../crypto.js';
import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';

const INTERRUPT_MESSAGE =
    'Please stop what you are doing right now and wait for further instructions.';

// Sends a user message asking the agent to stop its current work.
export async function interrupt(
    db: Database,
    client: HappyClient,
    sessionId: string,
): Promise<void> {
    const session = db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found in local registry`);

    const encryptionKey = decodeBase64(session.encryption_key);
    const encryptionVariant = session.encryption_variant as 'legacy' | 'dataKey';

    const userMessage = {
        role: 'user',
        content: { type: 'text', text: INTERRUPT_MESSAGE },
    };

    await client.sendMessages(sessionId, encryptionKey, encryptionVariant, [userMessage]);
    db.logAction('interrupt', sessionId, { message: INTERRUPT_MESSAGE }, 'ok');
}
