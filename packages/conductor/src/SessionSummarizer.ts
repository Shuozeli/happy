import { decodeBase64, decrypt } from './crypto.js';
import { HappyClient } from './HappyClient.js';
import type { SessionSnapshot } from './types.js';

const SYSTEM_PROMPT = `You are summarizing a coding session for someone listening on their phone, hands-free.
Be extremely concise. 2-3 spoken sentences maximum. No markdown. No bullet points. Plain conversational English.
Focus on: what the agent is working on, what progress has been made, and what it's doing right now.
If there's nothing meaningful to report, say so briefly.`;

type InferenceBackend =
    | { vendor: 'anthropic'; token: string }
    | { vendor: 'openai'; token: string };

function extractTextFromMessage(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const msg = body as Record<string, unknown>;

    // Session protocol envelope: { role: 'session', content: { role, ev: { t, text } } }
    if (msg.role === 'session' && msg.content && typeof msg.content === 'object') {
        const content = msg.content as Record<string, unknown>;
        const ev = content.ev as Record<string, unknown> | undefined;
        if (ev?.t === 'text' && typeof ev.text === 'string') {
            const role = typeof content.role === 'string' ? content.role : 'agent';
            return `[${role}] ${ev.text}`;
        }
        return null;
    }

    // ACP format: { role: 'agent', content: { type: 'acp', data: { type: 'message', message } } }
    if (msg.role === 'agent' && msg.content && typeof msg.content === 'object') {
        const content = msg.content as Record<string, unknown>;
        if (content.type === 'acp' && content.data && typeof content.data === 'object') {
            const data = content.data as Record<string, unknown>;
            if (data.type === 'message' && typeof data.message === 'string') {
                return `[agent] ${data.message}`;
            }
        }
        if (content.type === 'text' && typeof (content as Record<string, unknown>).text === 'string') {
            return `[agent] ${(content as Record<string, unknown>).text as string}`;
        }
        return null;
    }

    // User message: { role: 'user', content: { type: 'text', text } }
    if (msg.role === 'user' && msg.content && typeof msg.content === 'object') {
        const content = msg.content as Record<string, unknown>;
        if (content.type === 'text' && typeof content.text === 'string') {
            return `[user] ${content.text}`;
        }
    }

    return null;
}

async function resolveBackend(client: HappyClient): Promise<InferenceBackend | null> {
    // Prefer Anthropic (Claude) OAuth token stored in Happy cloud
    const anthropicData = await client.getVendorToken('anthropic');
    const anthropicToken =
        anthropicData &&
        typeof anthropicData === 'object' &&
        'oauth' in anthropicData &&
        anthropicData.oauth &&
        typeof anthropicData.oauth === 'object' &&
        'token' in anthropicData.oauth &&
        typeof anthropicData.oauth.token === 'string'
            ? anthropicData.oauth.token
            : null;
    if (anthropicToken) return { vendor: 'anthropic', token: anthropicToken };

    // Fall back to OpenAI (Codex) OAuth token
    const openaiData = await client.getVendorToken('openai');
    const openaiToken =
        openaiData &&
        typeof openaiData === 'object' &&
        'oauth' in openaiData &&
        openaiData.oauth &&
        typeof openaiData.oauth === 'object' &&
        'access_token' in openaiData.oauth &&
        typeof openaiData.oauth.access_token === 'string'
            ? openaiData.oauth.access_token
            : null;
    if (openaiToken) return { vendor: 'openai', token: openaiToken };

    // Final fallback: ANTHROPIC_API_KEY env var
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) return { vendor: 'anthropic', token: envKey };

    return null;
}

async function callAnthropic(token: string, context: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
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
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}`);
    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    return data.content.find((b) => b.type === 'text')?.text ?? '';
}

async function callOpenAI(token: string, context: string): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
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
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
}

export class SessionSummarizer {
    private backend: InferenceBackend | null | undefined = undefined; // undefined = not yet resolved

    constructor(private readonly client: HappyClient) {}

    async summarize(session: SessionSnapshot): Promise<string> {
        // Resolve backend once and cache
        if (this.backend === undefined) {
            this.backend = await resolveBackend(this.client);
            if (this.backend) {
                console.log(`[Summarizer] Using ${this.backend.vendor} for inference`);
            } else {
                console.warn('[Summarizer] No inference backend available — run "happy connect claude" or "happy connect codex", or set ANTHROPIC_API_KEY');
            }
        }

        if (!this.backend) {
            return `I can't summarize right now — no AI credentials are configured. Run "happy connect claude" or "happy connect codex" to enable summaries.`;
        }

        let allMessages: Array<{ seq: number; content: { t: string; c: string }; createdAt: number }> = [];
        try {
            allMessages = await this.client.fetchMessages(session.id, Math.max(0, session.lastSeq - 300), 200);
        } catch {
            return `I couldn't fetch messages for the session in ${session.directory}.`;
        }

        if (allMessages.length === 0) {
            return `The session in ${session.directory} has no recent messages.`;
        }

        const textLines: string[] = [];
        for (const msg of allMessages) {
            if (msg.content?.t !== 'encrypted') continue;
            try {
                const body = decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(msg.content.c));
                const text = extractTextFromMessage(body);
                if (text) textLines.push(text);
            } catch { /* skip undecryptable messages */ }
        }

        if (textLines.length === 0) {
            return `The session in ${session.directory} is active but I couldn't read the message content.`;
        }

        const transcript = textLines.slice(-100).join('\n');
        const context = `Working directory: ${session.directory}\nAgent type: ${session.agentType}\n\nRecent messages:\n${transcript}`;

        try {
            if (this.backend.vendor === 'anthropic') return await callAnthropic(this.backend.token, context);
            if (this.backend.vendor === 'openai') return await callOpenAI(this.backend.token, context);
        } catch (err) {
            console.error('[Summarizer] Inference call failed:', err);
            // Clear cached backend so next call retries resolution
            this.backend = undefined;
            return `I had trouble generating a summary for the session in ${session.directory}.`;
        }

        return `Session in ${session.directory} is ${session.status}.`;
    }
}
