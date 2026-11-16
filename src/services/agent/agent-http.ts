// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #374: the local agent over loopback. DBMN for VS Code listens on `http://127.0.0.1:<port>`,
 * the web app calls it: no shared folder, no polling, any browser that lets a secure page
 * reach loopback. This is the listener's whole HTTP surface, as a function, so every rule is tested
 * without a socket; the host's adapter (vscode-agent-listener.ts) only moves bytes.
 *
 *   GET  /agent/v1/hello     who is listening: `{ v, agentVersion, listenerId }`. Nothing else.
 *   POST /agent/v1/message   one signed message in (agent-signature.ts), its reply out. The
 *                            connection stays open until the reply: closing it is Cancel, and
 *                            an open connection is "the tab that asked is still there".
 *
 * Who may call:
 * - Only a page on the web app's origin (a dev build: a local dev server's too). A page anywhere
 *   else gets 403 and no CORS header, so its browser hands it nothing. A caller with no Origin
 *   (not a browser) is let through to the message check, where the signature decides.
 * - Only by the listener's own address (`Host: 127.0.0.1:<port>`): a name that resolves to
 *   loopback (DNS rebinding) is refused.
 * - The browser's preflight is answered, its private-network question included, for those
 *   origins only.
 *
 * What a message may ask for is `AgentHost`'s to say: this adds no trust.
 */
import { AGENT_PROTOCOL_VERSION } from './agent-protocol';
import type { AgentReply } from './local-agent';

export const AGENT_HELLO_PATH = '/agent/v1/hello';
export const AGENT_MESSAGE_PATH = '/agent/v1/message';
/** A prepared request with its body: more than this is not one. */
export const AGENT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const WEB_APP_ORIGIN = 'https://app.dbmn.io';

/** May a page on this origin call the agent? The web app; a local dev server too in a dev build. */
export function isAllowedAgentOrigin(origin: string, devBuild: boolean): boolean {
    if (origin === WEB_APP_ORIGIN) return true;
    return devBuild && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin);
}

export interface AgentHttpRequest {
    method: string;
    /** The path, without a query. */
    path: string;
    host?: string;
    origin?: string;
    /** The preflight asked `Access-Control-Request-Private-Network`. */
    privateNetwork?: boolean;
    body?: string;
}

export interface AgentHttpResponse {
    status: number;
    headers: Record<string, string>;
    body?: string;
}

export interface AgentHello { v: number; agentVersion?: string; listenerId: string }

export interface AgentHttpDeps {
    port: number;
    /** Names this listener: a message says which one it is for, so a copy can't be played to another window. */
    listenerId: string;
    agentVersion?: string;
    devBuild: boolean;
    /** `AgentHost.answer`, for a message addressed to this listener. */
    answer(raw: unknown, signal?: AbortSignal): Promise<AgentReply>;
}

const json = (status: number, body: unknown, headers: Record<string, string>): AgentHttpResponse =>
    ({ status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

export async function answerAgentHttp(request: AgentHttpRequest, deps: AgentHttpDeps, signal?: AbortSignal): Promise<AgentHttpResponse> {
    if (request.host !== `127.0.0.1:${deps.port}`) return json(403, { error: 'Not this address.' }, {});
    if (request.origin !== undefined && !isAllowedAgentOrigin(request.origin, deps.devBuild)) return json(403, { error: 'Not from the DBMN web app.' }, {});
    const cors: Record<string, string> = request.origin ? { 'Access-Control-Allow-Origin': request.origin, Vary: 'Origin' } : {};

    if (request.method === 'OPTIONS') {
        if (!request.origin) return json(403, { error: 'Not from the DBMN web app.' }, {});
        return {
            status: 204,
            headers: {
                ...cors,
                'Access-Control-Allow-Methods': 'GET, POST',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '600',
                ...(request.privateNetwork ? { 'Access-Control-Allow-Private-Network': 'true' } : {})
            }
        };
    }
    if (request.method === 'GET' && request.path === AGENT_HELLO_PATH) {
        const hello: AgentHello = { v: AGENT_PROTOCOL_VERSION, listenerId: deps.listenerId, ...(deps.agentVersion ? { agentVersion: deps.agentVersion } : {}) };
        return json(200, hello, cors);
    }
    if (request.method === 'POST' && request.path === AGENT_MESSAGE_PATH) {
        let raw: unknown;
        try {
            raw = JSON.parse(request.body ?? '');
        } catch {
            return json(400, { error: 'Not a message.' }, cors);
        }
        return json(200, await deps.answer(raw, signal), cors);
    }
    return json(404, { error: 'Not found.' }, cors);
}
