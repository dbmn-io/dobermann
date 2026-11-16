// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Who is asking: every message the web app sends DBMN for VS Code is signed, and VS Code runs
 * only what its own DBMN account's keys signed.
 *
 * - The web app makes a key pair in the browser, once (ECDSA P-256, Web Crypto). The private key
 *   is non-extractable and never leaves that browser; the public key goes on the user's DBMN
 *   account (`agent_keys`, own rows only: agent-keys.ts).
 * - A message crosses as `{ v, id, keyId, payload, signature }`: `payload` is the message's JSON
 *   text, and the signature is over exactly those bytes (no canonical form to get wrong).
 * - VS Code, signed in to the same account, looks the key up by `keyId` among its own account's
 *   keys and verifies. A key it can't find, or a signature that doesn't fit, is refused.
 *
 * Nothing secret crosses between the two, and nothing secret is on the account: a signature and
 * a public key. This is what says "from this user's web app"; nothing else about a message is
 * taken as proof (any local program can write one).
 *
 * The same Web Crypto in the browser, in VS Code's Node and in a desktop app.
 */

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Web Crypto's key type, as each host's compiler names it. */
type SubtleKey = Parameters<typeof crypto.subtle.exportKey>[1];
export interface AgentKeyPair { privateKey: SubtleKey; publicKey: SubtleKey }

/** What signs the web app's messages. */
export interface AgentSigner {
    /** Names the key: the SHA-256 of the public key. */
    keyId: string;
    /** The public key (SPKI, base64url): what goes on the account. */
    publicKey: string;
    /** The signature of `payload`'s bytes, base64url. */
    sign(payload: string): Promise<string>;
    /** Puts the public key on the account (again): VS Code said it doesn't know this key. */
    register?(): Promise<void>;
}

function toBase64Url(bytes: ArrayBuffer): string {
    let binary = '';
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** A new key pair. The private key can sign and nothing else: it can't be read out. */
export async function newAgentKeyPair(): Promise<AgentKeyPair> {
    return await crypto.subtle.generateKey(ALGORITHM, false, ['sign', 'verify']) as AgentKeyPair;
}

/** The name of a public key: the SHA-256 of its bytes, base64url (safe as a file name). */
export async function agentKeyId(publicKey: string): Promise<string> {
    return toBase64Url(await crypto.subtle.digest('SHA-256', fromBase64Url(publicKey)));
}

export async function agentSigner(pair: AgentKeyPair, register?: (signer: AgentSigner) => Promise<void>): Promise<AgentSigner> {
    const publicKey = toBase64Url(await crypto.subtle.exportKey('spki', pair.publicKey));
    const signer: AgentSigner = {
        keyId: await agentKeyId(publicKey),
        publicKey,
        sign: async payload => toBase64Url(await crypto.subtle.sign(SIGNING, pair.privateKey, new TextEncoder().encode(payload)))
    };
    if (register) signer.register = () => register(signer);
    return signer;
}

/** Did the holder of `publicKey` sign exactly this payload? False for anything that doesn't fit, never a throw. */
export async function verifyAgentSignature(publicKey: string, payload: string, signature: string): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey('spki', fromBase64Url(publicKey), ALGORITHM, false, ['verify']);
        return await crypto.subtle.verify(SIGNING, key, fromBase64Url(signature), new TextEncoder().encode(payload));
    } catch {
        return false;
    }
}
