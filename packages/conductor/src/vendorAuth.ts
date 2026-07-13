import type { HappyClient } from './HappyClient.js';

// Claude.ai OAuth client ID used by happy connect claude
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

// Refresh when fewer than 10 minutes remain on the access token.
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

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
        expires?: number; // Unix ms when access_token expires
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

// Serialize concurrent resolveBackend calls so only one refresh fires at a time.
// Without this, concurrent messages on startup all race to burn the same single-use
// refresh token, causing the 2nd+ calls to fail and cache null as the backend.
let _resolveInProgress: Promise<InferenceBackend | null> | null = null;

export function resolveBackend(client: HappyClient): Promise<InferenceBackend | null> {
    if (_resolveInProgress) return _resolveInProgress;
    _resolveInProgress = _doResolveBackend(client).finally(() => {
        _resolveInProgress = null;
    });
    return _resolveInProgress;
}

async function _doResolveBackend(client: HappyClient): Promise<InferenceBackend | null> {
    // ── Anthropic ────────────────────────────────────────────────────────────
    const anthropicData = await client.getVendorToken('anthropic');
    if (anthropicData && typeof anthropicData.token === 'string') {
        try {
            const inner = JSON.parse(anthropicData.token) as VendorTokenInner;
            const raw = inner.oauth?.raw;
            const expires = typeof inner.oauth?.expires === 'number' ? inner.oauth.expires : null;
            const stillValid = expires !== null && expires - Date.now() > REFRESH_BUFFER_MS;

            if (stillValid && typeof raw?.access_token === 'string') {
                // Token not yet expired — use directly, no refresh needed.
                return { vendor: 'anthropic', token: raw.access_token };
            }

            const refreshToken = raw?.refresh_token;
            if (typeof refreshToken === 'string') {
                // Token expired (or expiry unknown) and we have a refresh token.
                const refreshed = await refreshAnthropicToken(refreshToken);
                if (refreshed) {
                    const updatedInner: VendorTokenInner = {
                        ...inner,
                        oauth: {
                            ...inner.oauth,
                            raw: { ...raw, access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken },
                            expires: Date.now() + 8 * 60 * 60 * 1000, // 8h TTL
                        },
                    };
                    void client.registerVendorToken('anthropic', JSON.stringify(updatedInner));
                    return { vendor: 'anthropic', token: refreshed.accessToken };
                }
                // Refresh failed — don't fall back to the stale access_token.
            } else if (typeof raw?.access_token === 'string') {
                // No refresh token: treat the access_token as a long-lived key.
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
