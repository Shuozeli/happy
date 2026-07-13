import type { HappyClient } from './HappyClient.js';

// Claude.ai OAuth client ID used by happy connect claude
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

export type InferenceBackend =
    | { vendor: 'anthropic'; token: string }
    | { vendor: 'openai'; token: string };

type VendorTokenInner = {
    oauth?: {
        raw?: {
            access_token?: string;
            refresh_token?: string;
            [k: string]: unknown;
        };
        [k: string]: unknown;
    };
    [k: string]: unknown;
};

type RefreshResult = { accessToken: string; refreshToken: string };

async function refreshAnthropicToken(refreshToken: string): Promise<RefreshResult | null> {
    try {
        const res = await fetch(ANTHROPIC_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: ANTHROPIC_CLIENT_ID,
            }),
        });
        if (!res.ok) return null;
        const data = await res.json() as Record<string, unknown>;
        const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
        const newRefreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : null;
        if (!accessToken) return null;
        return { accessToken, refreshToken: newRefreshToken ?? refreshToken };
    } catch (err) {
        console.warn('[vendorAuth] Token refresh threw:', err);
        return null;
    }
}

export async function resolveBackend(client: HappyClient): Promise<InferenceBackend | null> {
    // ── Anthropic ────────────────────────────────────────────────────────────
    const anthropicData = await client.getVendorToken('anthropic');
    if (anthropicData && typeof anthropicData.token === 'string') {
        try {
            const inner = JSON.parse(anthropicData.token) as VendorTokenInner;
            const raw = inner.oauth?.raw;
            const refreshToken = raw?.refresh_token;

            if (typeof refreshToken === 'string') {
                // Always refresh: stored token may be expired (8 h TTL).
                // resolveBackend is cached by callers, so this runs at most once per start.
                const refreshed = await refreshAnthropicToken(refreshToken);
                if (refreshed) {
                    // Store both new access_token AND new refresh_token (tokens are single-use).
                    const updatedInner: VendorTokenInner = {
                        ...inner,
                        oauth: {
                            ...inner.oauth,
                            raw: { ...raw, access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken },
                        },
                    };
                    void client.registerVendorToken('anthropic', JSON.stringify(updatedInner));
                    return { vendor: 'anthropic', token: refreshed.accessToken };
                }
                // Refresh failed — don't fall back to the now-stale access_token.
                // Fall through to ANTHROPIC_API_KEY or OpenAI.
            } else if (typeof raw?.access_token === 'string') {
                // No refresh_token: assume the access_token is a long-lived key, use it directly.
                return { vendor: 'anthropic', token: raw.access_token };
            }
        } catch { /* ignore parse errors */ }
    }

    // ── OpenAI ───────────────────────────────────────────────────────────────
    const openaiData = await client.getVendorToken('openai');
    if (openaiData && typeof openaiData.token === 'string') {
        try {
            const inner = JSON.parse(openaiData.token) as VendorTokenInner;
            const token = inner.oauth?.raw?.access_token;
            if (typeof token === 'string') return { vendor: 'openai', token };
        } catch { /* ignore */ }
    }

    // ── Environment variable fallback ────────────────────────────────────────
    if (process.env.ANTHROPIC_API_KEY) {
        return { vendor: 'anthropic', token: process.env.ANTHROPIC_API_KEY };
    }

    return null;
}
