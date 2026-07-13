import { decodeBase64, decrypt } from '../crypto.js';
import type { Database } from '../db/Database.js';
import type { HappyClient } from '../HappyClient.js';
import { resolveBackend, type InferenceBackend } from '../vendorAuth.js';

const SYSTEM_PROMPT =
    'You are summarizing a coding session for someone listening on their phone, hands-free. ' +
    'Be extremely concise. 2-3 spoken sentences maximum. No markdown. No bullet points. ' +
    'Plain conversational English. Focus on: what the agent is working on, what progress has been made, ' +
    "and what it's doing right now. If there's nothing meaningful to report, say so briefly.";


function extractText(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const msg = body as Record<string, unknown>;

    if (msg.role === 'session' && typeof msg.content === 'object' && msg.content) {
        const content = msg.content as Record<string, unknown>;
        const ev = content.ev as Record<string, unknown> | undefined;
        if (ev?.t === 'text' && typeof ev.text === 'string') {
            return `[${typeof content.role === 'string' ? content.role : 'agent'}] ${ev.text}`;
        }
        return null;
    }

    if (msg.role === 'agent' && typeof msg.content === 'object' && msg.content) {
        const content = msg.content as Record<string, unknown>;
        if (content.type === 'acp' && typeof content.data === 'object' && content.data) {
            const data = content.data as Record<string, unknown>;
            if (data.type === 'message' && typeof data.message === 'string') {
                return `[agent] ${data.message}`;
            }
        }
        return null;
    }

    if (msg.role === 'user' && typeof msg.content === 'object' && msg.content) {
        const content = msg.content as Record<string, unknown>;
        if (content.type === 'text' && typeof content.text === 'string') {
            return `[user] ${content.text}`;
        }
    }

    return null;
}

function anthropicAuthHeader(token: string): Record<string, string> {
    return token.startsWith('sk-ant-oat')
        ? { Authorization: `Bearer ${token}` }
        : { 'x-api-key': token };
}

async function callAI(backend: InferenceBackend, context: string): Promise<string> {
    if (backend.vendor === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                ...anthropicAuthHeader(backend.token),
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: process.env.CONDUCTOR_MODEL ?? 'claude-haiku-4-5',
                max_tokens: 256,
                system: SYSTEM_PROMPT,
                messages: [{ role: 'user', content: context }],
            }),
        });
        if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
        const data = await res.json() as { content: Array<{ type: string; text: string }> };
        return data.content.find((b) => b.type === 'text')?.text ?? '';
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${backend.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: process.env.CONDUCTOR_MODEL ?? 'gpt-4o-mini',
            max_tokens: 256,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: context },
            ],
        }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
}

// Cached backend so we don't re-resolve on every call.
let cachedBackend: InferenceBackend | null | undefined;

export async function summarizeSession(
    db: Database,
    client: HappyClient,
    sessionId: string,
): Promise<string> {
    const session = db.getSession(sessionId);
    if (!session) return `I don't have session ${sessionId} in my registry. Try asking me to fetch sessions first.`;

    if (cachedBackend === undefined) {
        cachedBackend = await resolveBackend(client);
        if (!cachedBackend) {
            console.warn('[summarizeSession] No inference backend. Run "happy connect claude" or set ANTHROPIC_API_KEY.');
        }
    }

    if (!cachedBackend) {
        return 'I can\'t summarize right now — no AI credentials are configured. Run "happy connect claude" or set ANTHROPIC_API_KEY.';
    }

    const encryptionKey = decodeBase64(session.encryption_key);
    const encryptionVariant = session.encryption_variant as 'legacy' | 'dataKey';

    let messages: Array<{ seq: number; content: { t: string; c: string } }> = [];
    try {
        messages = await client.fetchMessages(sessionId, Math.max(0, session.seq - 300), 200);
    } catch {
        return `I couldn't fetch messages for the session in ${session.directory}.`;
    }

    const lines: string[] = [];
    for (const msg of messages) {
        if (msg.content?.t !== 'encrypted') continue;
        try {
            const body = decrypt(encryptionKey, encryptionVariant, decodeBase64(msg.content.c));
            const text = extractText(body);
            if (text) lines.push(text);
        } catch { /* skip undecryptable */ }
    }

    if (lines.length === 0) {
        return `The session in ${session.directory} is active but I couldn't read recent messages.`;
    }

    const context =
        `Working directory: ${session.directory}\nAgent type: ${session.agent_type}\n\n` +
        `Recent messages:\n${lines.slice(-100).join('\n')}`;

    try {
        const summary = await callAI(cachedBackend, context);
        db.updateSessionSummary(sessionId, summary);
        db.logAction('summarizeSession', sessionId, { lines: lines.length }, 'ok');
        return summary;
    } catch (err) {
        cachedBackend = undefined; // Force re-resolve next time
        console.error('[summarizeSession] AI call failed:', err);
        db.logAction('summarizeSession', sessionId, null, `error: ${String(err)}`);
        return `I had trouble generating a summary for the session in ${session.directory}.`;
    }
}
