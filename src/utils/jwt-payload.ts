// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A JWT's payload, unverified (what `jsonwebtoken.decode` returned), in any host: base64url
 * via atob and TextDecoder, no Node Buffer. Null when the token isn't a JWT.
 */
export function decodeJwtPayload<T extends object = Record<string, unknown>>(token: string): T | null {
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        return payload && typeof payload === 'object' ? payload as T : null;
    } catch {
        return null;
    }
}
