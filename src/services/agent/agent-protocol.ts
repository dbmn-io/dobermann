// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #375: the agent protocol (Architecture-v2.md, 2.3.1 and 2.4). What crosses between the web app
 * and DBMN for VS Code is untrusted on arrival: any tab, and any local process, can put a message
 * where the agent reads it. So every message and every reply is parsed here before anything acts
 * on it, and each carries the protocol version (`v`).
 *
 * - The agent answers the versions it knows. A newer web app's message gets "Update DBMN for
 *   VS Code"; a message with no version is a page from before versions, and is told to reload.
 * - The web app supports the agent's version and the one before it (the web app deploys ahead of
 *   the extension). A reply with no version is an agent from before versions: update it.
 * - A message crosses signed (agent-signature.ts): `{ v, id, keyId, payload, signature }`, the
 *   message itself being `payload`'s JSON. One with no signature is a page from before signing.
 * - OAuth: the agent only starts a sign-in whose callback is the web app's own page, and the web
 *   app only opens a sign-in page on the environment's own authorize host.
 *
 * The transport (the loopback listener, agent-http.ts) carries these unchanged.
 */
import { z } from 'zod';

export const AGENT_PROTOCOL_VERSION = 1;

export const UPDATE_VSCODE = 'Update DBMN for VS Code, then run again: this web app is newer than it.';
export const UNREADABLE_REPLY = 'DBMN for VS Code sent an answer the web app can\'t read. Update DBMN for VS Code, then run again.';
export const RELOAD_WEB_APP = 'Reload DBMN in your browser, then run again: this page is older than DBMN for VS Code.';

/** Ids are plain names: letters, digits, `_` and `-` only. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const safeId = z.string().regex(SAFE_ID).max(100);

const messageBase = {
    v: z.number().int(),
    id: safeId,
    userId: z.string().min(1).max(100),
    environmentId: z.string().min(1).max(200),
    sentAt: z.string().datetime(),
    /** The listener it is for: a copy can't be played to another VS Code window. */
    to: safeId
};

/** A prepared request: checked for its shape here; the executor validates the rest as it always does. */
const endpointSchema = z.object({ method: z.string().min(1).max(16), path: z.string().max(16_384) }).passthrough();
/** Only what the agent uses crosses: anything else on the options is dropped. */
const optionsSchema = z.object({
    isBatchMember: z.boolean().optional(),
    executionId: z.string().max(200).optional()
});

export const agentMessageSchema = z.discriminatedUnion('kind', [
    z.object({ ...messageBase, kind: z.literal('auth-status') }),
    z.object({ ...messageBase, kind: z.literal('sign-out') }),
    z.object({ ...messageBase, kind: z.literal('sign-in-start'), redirectUri: z.string().url().max(2048), forceLogin: z.boolean().optional() }),
    z.object({ ...messageBase, kind: z.literal('sign-in-finish'), code: z.string().min(1).max(4096), state: z.string().min(1).max(1024) }),
    z.object({ ...messageBase, kind: z.literal('request'), endpoint: endpointSchema, options: optionsSchema.optional() })
]);

export type ParsedAgentMessage = z.infer<typeof agentMessageSchema>;

/** Why a reply is a refusal, when the web app acts on it: `stale` is sent again, freshly stamped. */
/** ...and `unknown-key`: the web app registers its key again, then sends again. */
export type AgentRefusalCode = 'stale' | 'version' | 'unknown-key' | 'wrong-listener';

export type ReadAgentMessage =
    | { ok: true; message: ParsedAgentMessage }
    | { ok: false; id: string; error: string; code?: AgentRefusalCode };

const field = (raw: unknown, name: string): unknown => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[name] : undefined);
const safeIdOf = (value: unknown): string | undefined => (typeof value === 'string' && value.length <= 100 && SAFE_ID.test(value) ? value : undefined);

/** A message as it arrived: its version first, then its shape. */
export function readAgentMessage(raw: unknown): ReadAgentMessage {
    const id = safeIdOf(field(raw, 'id')) ?? '';
    const v = field(raw, 'v');
    if (typeof v !== 'number' || v < 1) return { ok: false, id, error: RELOAD_WEB_APP, code: 'version' };
    if (v > AGENT_PROTOCOL_VERSION) return { ok: false, id, error: UPDATE_VSCODE, code: 'version' };
    const parsed = agentMessageSchema.safeParse(raw);
    if (parsed.success) return { ok: true, message: parsed.data };
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'kind';
    return { ok: false, id, error: `DBMN for VS Code refused this request: "${where}" isn't what it expects (${issue?.message ?? 'invalid'}).` };
}

/** A message as it crosses: its JSON (`payload`), and the web app's signature over those bytes. */
export const signedMessageSchema = z.object({
    v: z.number().int(),
    id: safeId,
    keyId: safeId,
    payload: z.string().min(1),
    signature: z.string().regex(SAFE_ID).max(512)
});

export type SignedAgentMessage = z.infer<typeof signedMessageSchema>;

export type ReadSignedMessage =
    | { ok: true; signed: SignedAgentMessage; message: ParsedAgentMessage }
    | { ok: false; id: string; error: string; code?: AgentRefusalCode };

const refusedField = (where: string, why: string): string => `DBMN for VS Code refused this request: "${where}" isn't what it expects (${why}).`;

/**
 * What arrived, read but NOT yet verified: its version, the envelope, then the message inside.
 * Nothing is acted on from this alone: the host checks the signature next.
 */
export function readSignedMessage(raw: unknown): ReadSignedMessage {
    const id = safeIdOf(field(raw, 'id')) ?? '';
    const v = field(raw, 'v');
    if (typeof v !== 'number' || v < 1) return { ok: false, id, error: RELOAD_WEB_APP, code: 'version' };
    if (v > AGENT_PROTOCOL_VERSION) return { ok: false, id, error: UPDATE_VSCODE, code: 'version' };
    // No signature at all: a page from before signing
    if (field(raw, 'payload') === undefined && field(raw, 'signature') === undefined) return { ok: false, id, error: RELOAD_WEB_APP, code: 'version' };
    const envelope = signedMessageSchema.safeParse(raw);
    if (!envelope.success) {
        const issue = envelope.error.issues[0];
        return { ok: false, id, error: refusedField(issue?.path.join('.') || 'message', issue?.message ?? 'invalid') };
    }
    let inner: unknown;
    try {
        inner = JSON.parse(envelope.data.payload);
    } catch {
        return { ok: false, id, error: refusedField('payload', 'not JSON') };
    }
    const read = readAgentMessage(inner);
    if (!read.ok) return { ...read, id };
    // The envelope only repeats what the signed message says
    if (read.message.id !== envelope.data.id || read.message.v !== envelope.data.v) return { ok: false, id, error: refusedField('id', 'not the signed message\'s') };
    return { ok: true, signed: envelope.data, message: read.message };
}

/** Lenient on what an API can answer with; strict on what the web app reads from it. */
const responseSchema = z.object({
    success: z.boolean(),
    status: z.number().optional(),
    statusText: z.string().default(''),
    duration: z.number().default(0),
    url: z.string().default(''),
    error: z.string().optional()
}).passthrough();

const replyBase = { id: z.string(), v: z.number().int(), agentVersion: z.string().max(64).optional() };

export const agentReplySchema = z.discriminatedUnion('ok', [
    z.object({
        ...replyBase, ok: z.literal(true),
        response: responseSchema.optional(),
        signedIn: z.boolean().optional(),
        signIn: z.object({ url: z.string().url().max(8192), state: z.string().min(1).max(1024) }).optional()
    }),
    z.object({ ...replyBase, ok: z.literal(false), error: z.string(), code: z.string().max(32).optional() })
]);

export type ParsedAgentReply = z.infer<typeof agentReplySchema>;

/** The versions of the agent this web app works with: its own, and the one before. */
export function supportsAgentVersion(v: number): boolean {
    return v >= 1 && (v === AGENT_PROTOCOL_VERSION || v === AGENT_PROTOCOL_VERSION - 1);
}

/** A reply as it arrived, for the request `id`. Throws what the run shows when it can't be used. */
export function readAgentReply(raw: unknown, id: string): ParsedAgentReply {
    const v = field(raw, 'v');
    if (typeof v !== 'number') throw new Error(UPDATE_VSCODE);
    if (!supportsAgentVersion(v)) throw new Error(v > AGENT_PROTOCOL_VERSION ? RELOAD_WEB_APP : UPDATE_VSCODE);
    const parsed = agentReplySchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) throw new Error(UNREADABLE_REPLY);
    return parsed.data;
}

/** The web app's OAuth callback page: the only place the agent sends a sign-in back to. */
export const WEB_APP_CALLBACK = 'https://app.dbmn.io/oauth-callback.html';
const CALLBACK_PATH = '/oauth-callback.html';

/** May the agent start a sign-in that comes back here? The web app's page; a local dev server's in a dev build. */
export function isAllowedRedirectUri(uri: string, devBuild: boolean): boolean {
    if (uri === WEB_APP_CALLBACK) return true;
    if (!devBuild) return false;
    try {
        const url = new URL(uri);
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === CALLBACK_PATH
            && !url.search && !url.hash && !url.username && !url.password;
    } catch {
        return false;
    }
}

/** The origin of an environment's authorize page (a relative one is on its base URL). */
export function authorizeOrigin(environment: { baseUrl?: string; oauthConfig?: { authorizationUrl?: string; baseUrl?: string } } | undefined): string | undefined {
    const authorize = environment?.oauthConfig?.authorizationUrl;
    if (!authorize) return undefined;
    try {
        const url = new URL(authorize, environment?.oauthConfig?.baseUrl || environment?.baseUrl || undefined);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
    } catch {
        return undefined;
    }
}

/** May the web app open this sign-in page for this environment? Only one on its authorize host. */
export function isEnvironmentSignInUrl(url: string, environment: Parameters<typeof authorizeOrigin>[0]): boolean {
    const expected = authorizeOrigin(environment);
    if (!expected) return false;
    try {
        const page = new URL(url);
        return (page.protocol === 'https:' || page.protocol === 'http:') && page.origin === expected;
    } catch {
        return false;
    }
}
