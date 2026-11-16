// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #374: the loopback listener's HTTP surface, without a socket: who may call it, and that a
 * message gets the same `AgentHost` as on the folder.
 */
import { expect } from 'chai';
import { AGENT_HELLO_PATH, AGENT_MESSAGE_PATH, WEB_APP_ORIGIN, answerAgentHttp, isAllowedAgentOrigin, type AgentHttpDeps, type AgentHttpRequest } from '../../../services/agent/agent-http';
import { AGENT_PROTOCOL_VERSION } from '../../../services/agent/agent-protocol';
import { AGENT_WRONG_LISTENER, AgentHost, signAgentMessage, type AgentHostPorts, type AgentMessage } from '../../../services/agent/local-agent';
import { agentSigner, newAgentKeyPair, type AgentSigner } from '../../../services/agent/agent-signature';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import type { EnvironmentConfig } from '../../../environmentManager';

const PORT = 51234;
const HOST = `127.0.0.1:${PORT}`;
const endpoint = { id: 'e1', name: 'Get Carriers', method: 'GET', path: '/carriers', headers: {} } as unknown as APIEndpointConfig;

describe('The local agent over loopback (#374)', () => {
    let signer: AgentSigner;
    before(async () => { signer = await agentSigner(await newAgentKeyPair()); });

    const answered: unknown[] = [];
    const deps = (overrides: Partial<AgentHttpDeps> = {}): AgentHttpDeps => ({
        port: PORT, listenerId: 'listener-1', agentVersion: '0.4.0', devBuild: false,
        answer: async raw => { answered.push(raw); return { id: 'r1', ok: true, v: AGENT_PROTOCOL_VERSION }; },
        ...overrides
    });
    const call = (request: Partial<AgentHttpRequest>, overrides: Partial<AgentHttpDeps> = {}) =>
        answerAgentHttp({ method: 'GET', path: AGENT_HELLO_PATH, host: HOST, origin: WEB_APP_ORIGIN, ...request }, deps(overrides));
    beforeEach(() => { answered.length = 0; });

    it('hello says who is listening, to the web app\'s origin only', async () => {
        const hello = await call({});
        expect(hello.status).to.equal(200);
        expect(JSON.parse(hello.body ?? '')).to.deep.equal({ v: AGENT_PROTOCOL_VERSION, listenerId: 'listener-1', agentVersion: '0.4.0' });
        expect(hello.headers['Access-Control-Allow-Origin']).to.equal(WEB_APP_ORIGIN);
        expect(hello.headers.Vary).to.equal('Origin');
        expect(hello.headers['Cache-Control']).to.equal('no-store');
    });

    it('a page on any other origin gets 403 and no CORS header: its browser hands it nothing', async () => {
        for (const origin of ['https://evil.example', 'https://app.dbmn.io.evil.example', 'http://app.dbmn.io', 'null', 'http://127.0.0.1:5180', 'http://localhost:5180']) {
            for (const request of [{}, { method: 'OPTIONS' }, { method: 'POST', path: AGENT_MESSAGE_PATH, body: '{}' }]) {
                const refused = await call({ ...request, origin });
                expect(refused.status, `${origin} ${request.method ?? 'GET'}`).to.equal(403);
                expect(refused.headers['Access-Control-Allow-Origin']).to.equal(undefined);
            }
        }
        expect(answered, 'none reached the agent').to.deep.equal([]);
    });

    it('a dev build also answers a local dev server\'s page (127.0.0.1 only)', async () => {
        expect((await call({ origin: 'http://127.0.0.1:5180' }, { devBuild: true })).status).to.equal(200);
        expect(isAllowedAgentOrigin('http://localhost:5180', true)).to.equal(false);
        expect(isAllowedAgentOrigin('http://127.0.0.1:5180/x', true)).to.equal(false);
        expect(isAllowedAgentOrigin('https://127.0.0.1:5180', true)).to.equal(false);
        expect(isAllowedAgentOrigin(WEB_APP_ORIGIN, false)).to.equal(true);
    });

    it('only by its own address: a name that resolves to loopback (DNS rebinding) is refused', async () => {
        for (const host of ['evil.example', `localhost:${PORT}`, '127.0.0.1:1', `evil.example:${PORT}`, undefined]) {
            expect((await call({ host })).status, String(host)).to.equal(403);
            expect((await call({ host, method: 'POST', path: AGENT_MESSAGE_PATH, body: '{}' })).status).to.equal(403);
        }
        expect(answered).to.deep.equal([]);
    });

    it('the preflight is answered for the web app, its private-network question included', async () => {
        const preflight = await call({ method: 'OPTIONS', path: AGENT_MESSAGE_PATH, privateNetwork: true });
        expect(preflight.status).to.equal(204);
        expect(preflight.headers).to.include({
            'Access-Control-Allow-Origin': WEB_APP_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true'
        });
        expect((await call({ method: 'OPTIONS' })).headers['Access-Control-Allow-Private-Network'], 'only when asked').to.equal(undefined);
        expect((await call({ method: 'OPTIONS', origin: undefined })).status, 'a preflight is a browser\'s').to.equal(403);
    });

    it('a message goes to the agent and its reply comes back; anything else is not found', async () => {
        const reply = await call({ method: 'POST', path: AGENT_MESSAGE_PATH, body: '{"v":1,"id":"r1"}' });
        expect(reply.status).to.equal(200);
        expect(JSON.parse(reply.body ?? '')).to.deep.equal({ id: 'r1', ok: true, v: AGENT_PROTOCOL_VERSION });
        expect(answered).to.deep.equal([{ v: 1, id: 'r1' }]);
        expect((await call({ method: 'POST', path: AGENT_MESSAGE_PATH, body: 'not json' })).status).to.equal(400);
        expect((await call({ path: '/agent/v1/environments' })).status).to.equal(404);
        expect((await call({ method: 'DELETE', path: AGENT_MESSAGE_PATH })).status).to.equal(404);
        expect(answered.length, 'only the one message').to.equal(1);
    });

    it('a caller that is no browser (no Origin) reaches the message check, where the signature decides', async () => {
        const sent: string[] = [];
        const ports: AgentHostPorts = {
            userId: () => 'user-1',
            publicKey: async keyId => (keyId === signer.keyId ? signer.publicKey : undefined),
            getEnvironment: async () => ({ id: 'env-1', name: 'Staging', baseUrl: 'https://api.example', authMethod: 'none' } as EnvironmentConfig),
            executor: { executeEndpoint: async e => { sent.push(e.path); return { success: true, status: 200, statusText: 'OK', data: {}, duration: 1, url: '' }; } },
            authGate: { isAuthenticationValid: async () => true },
            oauthStart: async () => ({ url: '', state: '' }), oauthFinish: async () => undefined, oauthSignOut: async () => undefined,
            log: () => undefined
        };
        const host = new AgentHost(ports);
        const over = (body: unknown) => answerAgentHttp(
            { method: 'POST', path: AGENT_MESSAGE_PATH, host: HOST, body: JSON.stringify(body) },
            deps({ answer: (raw, signal) => host.answer(raw, 'listener-1', signal) })
        ).then(response => JSON.parse(response.body ?? '') as { ok: boolean; error?: string; code?: string });
        const message = (id: string, to: string): AgentMessage => ({
            v: AGENT_PROTOCOL_VERSION, id, userId: 'user-1', environmentId: 'env-1', sentAt: new Date().toISOString(), kind: 'request', endpoint, to
        });

        expect(await over(message('r1', 'listener-1')), 'unsigned').to.include({ ok: false });
        expect(sent).to.deep.equal([]);
        expect((await over(await signAgentMessage(message('r2', 'listener-1'), signer))).ok, 'signed, and for this listener').to.equal(true);
        expect(sent).to.deep.equal(['/carriers']);
        // Signed for another window's listener: not this one's to answer
        expect(await over(await signAgentMessage(message('r3', 'listener-2'), signer))).to.include({ ok: false, error: AGENT_WRONG_LISTENER, code: 'wrong-listener' });
        expect(sent).to.deep.equal(['/carriers']);
    });
});
