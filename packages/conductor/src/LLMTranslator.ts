import { z } from 'zod';
import type { HappyClient } from './HappyClient.js';
import type { SessionRow, ConversationRow } from './db/Database.js';

// ── Schema ───────────────────────────────────────────────────────────────────

export const LLMPlan = z.object({
    action: z.union([
        z.literal('fetch_sessions'),
        z.literal('send_to_session'),
        z.literal('interrupt'),
        z.literal('grant_access'),
        z.literal('summarize_session'),
        z.literal('spawn_session'),
        z.literal('none'),
    ]),
    session_id: z.string().nullable(),
    params:     z.record(z.string(), z.unknown()).nullable(),
    reply:      z.string(),
});

export type LLMPlan = z.infer<typeof LLMPlan>;

const FALLBACK_PLAN: LLMPlan = {
    action: 'none',
    session_id: null,
    params: null,
    reply: "I didn't understand that. Try saying: list my sessions, summarize session, interrupt session, or start a new session.",
};

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
    return `You are Conductor, a local session manager for Claude Code running on the user's machine.
Your job is to interpret the user's voice command and decide which action to take.

Reply with ONLY a JSON object — no prose, no markdown fences. Schema:
{
  "action": one of: "fetch_sessions" | "send_to_session" | "interrupt" | "grant_access" | "summarize_session" | "spawn_session" | "none",
  "session_id": string (from the active sessions list) or null,
  "params": object or null,
  "reply": string (what Conductor says back — plain spoken English, no markdown, ≤2 sentences)
}

Action rules:
- "fetch_sessions": refresh the session list. session_id=null, params=null.
- "send_to_session": send a message to a session. params={"message":"<text>"}.
- "interrupt": immediately stop a session's current work. session_id required, params=null.
- "grant_access": approve or deny a permission request. params={"requestId":"<id>","allow":true|false}.
- "summarize_session": summarize what a session is doing. session_id required, params=null. Set reply to "Let me check that session for you." — the real summary replaces it.
- "spawn_session": start a new session. session_id=null, params={"directory":"<path>"}.
- "none": for greetings, thanks, or anything that needs no action.

IMPORTANT:
- Never invent a session_id. Only use IDs from the active sessions list provided.
- If the user refers to a session by name or directory, match it to the closest entry in the list.
- If you cannot confidently identify which session they mean, ask for clarification via "none".
- Keep "reply" conversational and brief — it will be spoken aloud.`;
}

function buildUserPrompt(
    text: string,
    sessions: SessionRow[],
    history: ConversationRow[],
): string {
    const sessionList = sessions.length === 0
        ? 'No active sessions.'
        : sessions.map((s, i) => {
            const dir = s.directory.replace(process.env.HOME ?? '/root', '~');
            const summary = s.summary_text ? ` — ${s.summary_text}` : '';
            return `${i + 1}. id=${s.id} dir=${dir} type=${s.agent_type} state=${s.lifecycle_state}${summary}`;
        }).join('\n');

    const historyText = history.length === 0
        ? 'No prior conversation.'
        : [...history].reverse().map((h) => `${h.role}: ${h.text}`).join('\n');

    return `Active sessions:\n${sessionList}\n\nRecent conversation:\n${historyText}\n\nUser says: "${text}"`;
}

// ── Backend resolution (shared with summarizeSession) ────────────────────────

type InferenceBackend =
    | { vendor: 'anthropic'; token: string }
    | { vendor: 'openai'; token: string };

async function resolveBackend(client: HappyClient): Promise<InferenceBackend | null> {
    const anthropicData = await client.getVendorToken('anthropic');
    const anthropicToken =
        anthropicData &&
        typeof anthropicData === 'object' &&
        'oauth' in anthropicData &&
        anthropicData.oauth &&
        typeof anthropicData.oauth === 'object' &&
        'token' in anthropicData.oauth &&
        typeof (anthropicData.oauth as Record<string, unknown>).token === 'string'
            ? (anthropicData.oauth as Record<string, unknown>).token as string
            : null;
    if (anthropicToken) return { vendor: 'anthropic', token: anthropicToken };

    const openaiData = await client.getVendorToken('openai');
    const openaiToken =
        openaiData &&
        typeof openaiData === 'object' &&
        'oauth' in openaiData &&
        openaiData.oauth &&
        typeof openaiData.oauth === 'object' &&
        'access_token' in openaiData.oauth &&
        typeof (openaiData.oauth as Record<string, unknown>).access_token === 'string'
            ? (openaiData.oauth as Record<string, unknown>).access_token as string
            : null;
    if (openaiToken) return { vendor: 'openai', token: openaiToken };

    if (process.env.ANTHROPIC_API_KEY) return { vendor: 'anthropic', token: process.env.ANTHROPIC_API_KEY };

    return null;
}

function stripJsonFences(text: string): string {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function callAI(backend: InferenceBackend, system: string, user: string): Promise<string> {
    if (backend.vendor === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${backend.token}`,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: process.env.CONDUCTOR_ROUTER_MODEL ?? 'claude-haiku-4-5',
                max_tokens: 512,
                system,
                messages: [{ role: 'user', content: user }],
            }),
        });
        if (!res.ok) throw new Error(`Anthropic ${res.status}`);
        const data = await res.json() as { content: Array<{ type: string; text: string }> };
        return data.content.find((b) => b.type === 'text')?.text ?? '';
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: process.env.CONDUCTOR_ROUTER_MODEL ?? 'gpt-4o-mini',
            max_tokens: 512,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
}

// ── LLMTranslator class ──────────────────────────────────────────────────────

export class LLMTranslator {
    private backend: InferenceBackend | null | undefined = undefined;

    constructor(private readonly client: HappyClient) {}

    async translate(
        text: string,
        sessions: SessionRow[],
        history: ConversationRow[],
    ): Promise<LLMPlan> {
        if (this.backend === undefined) {
            this.backend = await resolveBackend(this.client);
            if (!this.backend) {
                console.warn('[LLMTranslator] No AI backend. Run "happy connect claude" or set ANTHROPIC_API_KEY.');
            }
        }

        if (!this.backend) {
            return {
                ...FALLBACK_PLAN,
                reply: 'No AI credentials configured. Run "happy connect claude" to enable full functionality.',
            };
        }

        const system = buildSystemPrompt();
        const user = buildUserPrompt(text, sessions, history);

        try {
            const raw = await callAI(this.backend, system, user);
            const json = JSON.parse(stripJsonFences(raw));
            const result = LLMPlan.safeParse(json);

            if (!result.success) {
                console.warn('[LLMTranslator] Zod validation failed:', result.error.issues);
                return FALLBACK_PLAN;
            }

            // Guard: reject session_id values not in the active list
            if (result.data.session_id !== null) {
                const validIds = new Set(sessions.map((s) => s.id));
                if (!validIds.has(result.data.session_id)) {
                    console.warn('[LLMTranslator] LLM returned unknown session_id, ignoring');
                    return { ...FALLBACK_PLAN, reply: "I couldn't identify which session you meant. Try listing your sessions first." };
                }
            }

            return result.data;
        } catch (err) {
            console.error('[LLMTranslator] Failed:', err);
            this.backend = undefined; // Force re-resolve next call
            return FALLBACK_PLAN;
        }
    }
}
