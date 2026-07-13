import { decodeBase64, decrypt } from '../crypto.js';
import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';

const INTERRUPT_MESSAGE =
    'Please stop what you are doing right now and wait for further instructions.';

// Interrupt a session: deny any pending permission requests first (so the agent
// is unblocked), then send a stop message.
export async function interrupt(
    db: Database,
    client: HappyClient,
    sessionId: string,
): Promise<void> {
    const session = db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found in local registry`);

    const encryptionKey = decodeBase64(session.encryption_key);
    const encryptionVariant = session.encryption_variant as 'legacy' | 'dataKey';

    // Step 1: Deny any pending permission requests so the agent is unblocked.
    try {
        const rawSessions = await client.listSessions();
        const raw = rawSessions.find((s) => s.id === sessionId);
        if (raw?.agentState) {
            const agentState = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState));
            const requests = (agentState as { requests?: Record<string, unknown> } | null)?.requests ?? {};
            const pendingIds = Object.keys(requests);
            if (pendingIds.length > 0) {
                console.log(`[interrupt] Denying ${pendingIds.length} pending permission request(s)`);
                for (const requestId of pendingIds) {
                    try {
                        await client.callSessionRpc(sessionId, 'permission', encryptionKey, encryptionVariant, {
                            id: requestId,
                            approved: false,
                            decision: 'abort',
                        });
                    } catch (err) {
                        // RPC relay may not be available on prod — log and continue.
                        console.warn(`[interrupt] Could not deny permission ${requestId}:`, err instanceof Error ? err.message : err);
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[interrupt] Could not check agentState:', err instanceof Error ? err.message : err);
    }

    // Step 2: Send the stop message. If the agent was permission-blocked and the
    // RPC call above succeeded, it is now unblocked and will see this message.
    const userMessage = {
        role: 'user',
        content: { type: 'text', text: INTERRUPT_MESSAGE },
    };
    await client.sendMessages(sessionId, encryptionKey, encryptionVariant, [userMessage]);
    db.logAction('interrupt', sessionId, { message: INTERRUPT_MESSAGE }, 'ok');
}
