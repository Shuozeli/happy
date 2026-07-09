import { decodeBase64 } from '../crypto.js';
import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';

// Calls the `abort` RPC on the target session, stopping its current execution immediately.
// Requires POST /v1/sessions/:id/rpc/:method on the Happy server (see DESIGN.md OQ-2).
export async function interrupt(
    db: Database,
    client: HappyClient,
    sessionId: string,
): Promise<void> {
    const session = db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found in local registry`);

    const encryptionKey = decodeBase64(session.encryption_key);
    const encryptionVariant = session.encryption_variant as 'legacy' | 'dataKey';

    await client.callSessionRpc(sessionId, 'abort', encryptionKey, encryptionVariant, {});
    db.logAction('interrupt', sessionId, { rpcMethod: 'abort' }, 'ok');
}
