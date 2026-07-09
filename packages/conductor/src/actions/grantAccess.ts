import { decodeBase64 } from '../crypto.js';
import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';

// Resolves a pending permission request on the target session via the `permission` RPC.
// requestId must match an entry in agentState.requests on the session.
// Requires POST /v1/sessions/:id/rpc/:method on the Happy server (see DESIGN.md OQ-1).
export async function grantAccess(
    db: Database,
    client: HappyClient,
    sessionId: string,
    requestId: string,
    allow: boolean,
): Promise<void> {
    const session = db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found in local registry`);

    const encryptionKey = decodeBase64(session.encryption_key);
    const encryptionVariant = session.encryption_variant as 'legacy' | 'dataKey';

    const payload = {
        id: requestId,
        approved: allow,
        decision: allow ? 'approved' : 'denied',
    };

    await client.callSessionRpc(sessionId, 'permission', encryptionKey, encryptionVariant, payload);
    db.logAction('grantAccess', sessionId, { requestId, allow }, 'ok');
}
