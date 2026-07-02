import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';

export function encodeBase64(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString('base64');
}

export function decodeBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function getRandomBytes(size: number): Uint8Array {
    return new Uint8Array(randomBytes(size));
}

export function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
    const encrypted = tweetnacl.secretbox(
        new TextEncoder().encode(JSON.stringify(data)),
        nonce,
        secret,
    );
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptLegacy(data: Uint8Array, secret: Uint8Array): unknown | null {
    const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
    const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
    const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
    if (!decrypted) return null;
    return JSON.parse(new TextDecoder().decode(decrypted));
}

export function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const bundle = new Uint8Array(1 + 12 + encrypted.length + 16);
    bundle.set([0], 0);
    bundle.set(nonce, 1);
    bundle.set(new Uint8Array(encrypted), 13);
    bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
    return bundle;
}

export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): unknown | null {
    if (bundle.length < 1 || bundle[0] !== 0) return null;
    if (bundle.length < 1 + 12 + 16) return null;
    const nonce = bundle.slice(1, 13);
    const authTag = bundle.slice(bundle.length - 16);
    const ciphertext = bundle.slice(13, bundle.length - 16);
    try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

export function encrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: unknown): Uint8Array {
    return variant === 'legacy' ? encryptLegacy(data, key) : encryptWithDataKey(data, key);
}

export function decrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): unknown | null {
    return variant === 'legacy' ? decryptLegacy(data, key) : decryptWithDataKey(data, key);
}

export function decryptBoxBundle(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    if (bundle.length < 56) return null;
    const ephemeralPublicKey = bundle.slice(0, 32);
    const nonce = bundle.slice(32, 56);
    const ciphertext = bundle.slice(56);
    const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
    return decrypted ? new Uint8Array(decrypted) : null;
}

export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = tweetnacl.box.keyPair();
    const nonce = getRandomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
    const result = new Uint8Array(32 + nonce.length + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, 32);
    result.set(encrypted, 32 + nonce.length);
    return result;
}

// Derives the content key pair from the master secret (for unwrapping session data keys)
export function deriveContentKeyPair(secret: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
    const hmac = (key: Uint8Array, data: Uint8Array) => {
        const h = createHmac('sha512', key);
        h.update(data);
        return new Uint8Array(h.digest());
    };

    const root = hmac(new TextEncoder().encode('Happy EnCoder Master Seed'), secret);
    let state = { key: root.slice(0, 32), chainCode: root.slice(32) };

    const path = ['content'];
    for (const index of path) {
        const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
        const derived = hmac(state.chainCode, data);
        state = { key: derived.slice(0, 32), chainCode: derived.slice(32) };
    }

    const hashedSeed = new Uint8Array(createHash('sha512').update(state.key).digest());
    const secretKey = hashedSeed.slice(0, 32);
    const keyPair = tweetnacl.box.keyPair.fromSecretKey(secretKey);
    return { publicKey: new Uint8Array(keyPair.publicKey), secretKey: new Uint8Array(keyPair.secretKey) };
}
