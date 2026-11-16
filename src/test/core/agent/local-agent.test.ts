// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The local agent (#344 step 4, #374): the web app hands prepared requests to DBMN for VS Code.
 * These run both sides against each other in memory: the client's transport calls the host
 * straight, as the loopback listener does.
 */
import { expect } from 'chai';
import {
    AGENT_NOT_RUNNING,
    AGENT_WAITING,
    ALIVE_MS,
    AgentClient,
    AgentHost,
    AgentHostPorts,
    AgentMessage,
    AgentTransport,
    BROWSER_BLOCKED,
    EnvironmentLimiter,
    agentAwareAuthGate,
    environmentThreads,
    routeByEnvironment,
    AGENT_REDIRECT_REFUSED,
    AGENT_SIGN_IN_PAGE_REFUSED,
    AGENT_STALE,
    AGENT_ANSWERED_BEFORE,
    AGENT_LOST,
    isAgentLost,
    AGENT_NOT_SIGNED,
    AGENT_UNKNOWN_BROWSER,
    AGENT_WRONG_LISTENER,
    signAgentMessage
} from '../../../services/agent/local-agent';
import {
    AGENT_PROTOCOL_VERSION, RELOAD_WEB_APP, UPDATE_VSCODE, WEB_APP_CALLBACK, isAllowedRedirectUri, isEnvironmentSignInUrl, type SignedAgentMessage
} from '../../../services/agent/agent-protocol';
import { agentKeyId, agentSigner, newAgentKeyPair, verifyAgentSignature, type AgentSigner } from '../../../services/agent/agent-signature';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import type { EnvironmentConfig } from '../../../environmentManager';
import type { EndpointResponse, IRequestExecutor } from '../../../services/execution/request-executor.interface';
import type { IEnvironmentAuthGate } from '../../../services/environment/auth-gate';
import type { ModalHost } from '../../../screens/modal.types';

const endpoint = { id: 'e1', name: 'Get Carriers', method: 'GET', path: '/carriers', headers: {} } as unknown as APIEndpointConfig;
const ok = (status = 200): EndpointResponse => ({ success: true, status, statusText: 'OK', data: { ok: true }, duration: 5, url: 'https://api.example/carriers' });
const environment = (overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig =>
    ({
        id: 'env-1', name: 'Staging', baseUrl: 'https://api.example', authMethod: 'oauth', runOn: 'local-agent',
        oauthConfig: { authorizationUrl: 'https://login.example/authorize' }, ...overrides
    } as EnvironmentConfig);

/** The VS Code window's listener in these tests. */
const LISTENER = 'listener-1';
/** The fake time every helper shares: the clock moves it. */
let fakeNow = 0;
/** A message's stamp, on that clock. */
const at = (ago = 0) => new Date(fakeNow - ago).toISOString();
/** A message as the web app addresses it. */
const addressed = { v: AGENT_PROTOCOL_VERSION, userId: 'user-1', environmentId: 'env-1', to: LISTENER };

/** This browser's key; its public half is on VS Code's account (hostPorts). */
let signer: AgentSigner;
before(async () => { signer = await agentSigner(await newAgentKeyPair()); });

/** A message as it crosses: its JSON, signed with `by`. */
async function sealed(message: unknown, by: Pick<AgentSigner, 'keyId' | 'sign'> = signer) {
    const m = message as { v?: number; id?: string } | null;
    const payload = JSON.stringify(message);
    return { v: m?.v, id: m?.id, keyId: by.keyId, payload, signature: await by.sign(payload) };
}

/** The host, taking a bare message as the web app would send it: signed by this browser's key, at this listener. */
class TestHost extends AgentHost {
    async answer(raw: unknown, addressedTo: string = LISTENER, signal?: AbortSignal) {
        const isSealed = !!raw && typeof raw === 'object' && 'signature' in raw;
        return super.answer(isSealed ? raw : await sealed(raw), addressedTo, signal);
    }
}

/** A fake clock: sleeping moves time on, and lets something happen in between. */
function clock(onTick: () => Promise<void> | void = () => undefined) {
    fakeNow = 0;
    return {
        now: () => fakeNow,
        sleep: async (ms: number) => { fakeNow += ms; await onTick(); }
    };
}

/**
 * VS Code, as the web app reaches it: a listener that hands each message to the host, as the
 * loopback listener does (the message crosses as JSON). `there`: is VS Code open?
 */
function vsCode(host: AgentHost, options: { there?: () => boolean; listenerId?: () => string } = {}): AgentTransport & { crossed: SignedAgentMessage[]; looks: number } {
    const transport = {
        crossed: [] as SignedAgentMessage[],
        looks: 0,
        connect: async () => {
            transport.looks++;
            if (options.there && !options.there()) return undefined;
            const listenerId = options.listenerId?.() ?? LISTENER;
            return {
                listenerId,
                send: async (message: SignedAgentMessage, signal?: AbortSignal) => {
                    transport.crossed.push(message);
                    const reply = host.answer(JSON.parse(JSON.stringify(message)), LISTENER, signal);
                    // Hanging up ends the call for the web app at once, whatever VS Code is still doing
                    return await Promise.race([reply, new Promise<never>((_resolve, reject) => {
                        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                    })]);
                }
            };
        }
    };
    return transport;
}

/** What the web app sent: the message inside its signed envelope. */
const written = (message: SignedAgentMessage | undefined): AgentMessage | undefined => (message ? JSON.parse(message.payload) as AgentMessage : undefined);

function hostPorts(overrides: Partial<AgentHostPorts> = {}): AgentHostPorts {
    return {
        userId: () => 'user-1',
        publicKey: async keyId => (keyId === signer.keyId ? signer.publicKey : undefined),
        getEnvironment: async id => (id === 'env-1' ? environment() : undefined),
        executor: { executeEndpoint: async () => ok() },
        authGate: { isAuthenticationValid: async () => true },
        oauthStart: async () => ({ url: 'https://login.example/authorize', state: 'st' }),
        oauthFinish: async () => undefined,
        oauthSignOut: async () => undefined,
        now: () => fakeNow,
        log: () => undefined,
        ...overrides
    };
}

describe('Local agent (#344 step 4, #374)', () => {
    it('a request goes to VS Code and its response comes back', async () => {
        let sent: { endpoint: APIEndpointConfig; environmentId?: string } | undefined;
        const host = new TestHost(hostPorts({ executor: { executeEndpoint: async (e, _s, environmentId) => { sent = { endpoint: e, environmentId }; return ok(201); } } }));
        const transport = vsCode(host);
        const client = new AgentClient(transport, () => 'user-1', { signer, ...clock(), newId: () => 'r1' });

        const response = await client.execute('env-1', endpoint);

        expect(response.status).to.equal(201);
        expect(sent?.endpoint.path).to.equal('/carriers');
        expect(sent?.environmentId, 'VS Code sends it in that environment (its base URL and token)').to.equal('env-1');
        expect(written(transport.crossed[0]), 'addressed to the listener it was sent to').to.include({ id: 'r1', kind: 'request', userId: 'user-1', to: LISTENER });
    });

    it('no VS Code yet: the request waits, says so, and goes the moment VS Code comes', async () => {
        const host = new TestHost(hostPorts());
        const transport = vsCode(host, { there: () => fakeNow >= 60_000 });
        const waiting: boolean[] = [];
        const consoles: string[] = [];
        const client = new AgentClient(transport, () => 'user-1', {
            signer, ...clock(), newId: () => 'r1', onWaiting: w => waiting.push(w), onRequestWaiting: (id, w) => consoles.push(`${id} ${w}`)
        });
        const response = await client.execute('env-1', endpoint, { executionId: 'exec-9' });
        expect([...new Set(consoles)], 'its Console hears it waits, then that it goes').to.deep.equal(['exec-9 true', 'exec-9 false']);
        expect(consoles.at(-1)).to.equal('exec-9 false');
        expect(fakeNow, 'it waited for VS Code').to.equal(60_000);
        expect(response.status).to.equal(200);
        expect(waiting, 'said it was waiting, then that it stopped').to.deep.equal([true, false]);
        expect(transport.crossed.length, 'sent once, when VS Code was there').to.equal(1);
        expect(Date.parse(written(transport.crossed[0])!.sentAt), 'and stamped then, not when the wait began').to.equal(60_000);
    });

    it('waitUntilConnected: waits (saying so for the run), true once VS Code comes; at once when it\'s there', async () => {
        const consoles: string[] = [];
        const transport = vsCode(new TestHost(hostPorts()), { there: () => fakeNow >= 3_000 });
        const client = new AgentClient(transport, () => 'user-1', { ...clock(), onRequestWaiting: (id, w) => consoles.push(`${id} ${w}`) });
        expect(await client.waitUntilConnected(undefined, 'exec-1')).to.equal(true);
        expect([...new Set(consoles)], 'waiting (said each second: its Console may open late), then not').to.deep.equal(['exec-1 true', 'exec-1 false']);
        expect(consoles.at(-1)).to.equal('exec-1 false');
        expect(transport.crossed, 'nothing sent while it waited').to.deep.equal([]);
        expect(await client.waitUntilConnected(), 'there already').to.equal(false);
    });

    it('#335: waiting can be cancelled: the request is never sent, and the run records a cancel, not an error', async () => {
        const cancel = new AbortController();
        const transport = vsCode(new TestHost(hostPorts()), { there: () => false });
        const client = new AgentClient(transport, () => 'user-1', { signer, ...clock(() => { if (fakeNow > 5_000) cancel.abort(); }), newId: () => 'r1' });
        const error = await client.execute('env-1', endpoint, undefined, cancel.signal).catch(e => e as Error);
        expect((error as Error).message).to.match(/Cancelled/);
        expect((error as Error).name).to.equal('AbortError');
        expect(transport.crossed).to.deep.equal([]);
    });

    it('#335: Cancel while VS Code is sending it hangs up: VS Code aborts the request, and the run ends at once as cancelled', async () => {
        const cancel = new AbortController();
        let signalSeen: AbortSignal | undefined;
        // An API that never answers: only Cancel ends it
        const host = new TestHost(hostPorts({ executor: { executeEndpoint: (_e, signal) => { signalSeen = signal; setTimeout(() => cancel.abort(), 5); return new Promise<EndpointResponse>(() => undefined); } } }));
        const client = new AgentClient(vsCode(host), () => 'user-1', { signer, ...clock(), newId: () => 'r1' });
        const error = await client.execute('env-1', endpoint, undefined, cancel.signal).catch(e => e as Error);
        expect((error as Error).name).to.equal('AbortError');
        expect(signalSeen?.aborted, 'the hang-up reached VS Code\'s executor').to.equal(true);
    });

    it('#335: a request cancelled before its turn (the environment\'s threads busy) is never sent', async () => {
        let sent = false;
        const idle = new TestHost(hostPorts({ executor: { executeEndpoint: async () => { sent = true; return ok(); } } }));
        const reply = await idle.answer({ ...addressed, kind: 'request', id: 'r2', sentAt: at(), endpoint }, LISTENER, AbortSignal.abort());
        expect(reply.ok).to.equal(false);
        expect(sent).to.equal(false);
    });

    it('a question that needs VS Code now (signed in?) fails at once without it', async () => {
        const client = new AgentClient(vsCode(new TestHost(hostPorts()), { there: () => false }), () => 'user-1', { signer, ...clock() });
        let error: Error | undefined;
        await client.isSignedIn('env-1').catch(e => { error = e; });
        expect(error?.message).to.equal(AGENT_NOT_RUNNING);
    });

    it('connected: VS Code answers, and only while it does', async () => {
        let open = false;
        const client = new AgentClient(vsCode(new TestHost(hostPorts()), { there: () => open }), () => 'user-1', clock());
        expect(await client.connected(), 'not open').to.equal(false);
        open = true;
        expect(await client.connected()).to.equal(true);
        open = false;
        expect(await client.connected(), 'closed').to.equal(false);
    });

    it('a request that takes longer than its limit hangs up; a connection that goes before the answer says nobody knows if it was sent', async () => {
        const never = new TestHost(hostPorts({ executor: { executeEndpoint: () => new Promise<EndpointResponse>(() => undefined) } }));
        const slow = new AgentClient(vsCode(never), () => 'user-1', {
            signer, ...clock(), newId: () => 'r1',
            timeoutMs: { request: 20, 'sign-in-start': 20, 'sign-in-finish': 20, 'sign-out': 20, 'auth-status': 20 }
        });
        expect(await slow.execute('env-1', endpoint).then(() => 'sent', (e: Error) => e.message)).to.equal('DBMN for VS Code took too long to answer.');

        const gone: AgentTransport = { connect: async () => ({ listenerId: LISTENER, send: async () => { throw new Error(AGENT_LOST); } }) };
        const lost = new AgentClient(gone, () => 'user-1', { signer, ...clock(), newId: () => 'r2' });
        expect(await lost.execute('env-1', endpoint).then(() => 'sent', (e: Error) => e.message)).to.equal(AGENT_LOST);
    });

    it('VS Code just started: waits for its catalogue to bring the environment, then answers', async () => {
        let lookups = 0;
        const host = new TestHost(hostPorts({
            getEnvironment: async () => (++lookups < 3 ? undefined : environment()),
            sleep: async () => undefined
        }));
        const reply = await host.answer({ ...addressed, id: 'r1', kind: 'request', sentAt: at(), endpoint });
        expect(reply.ok, JSON.stringify(reply)).to.equal(true);
        expect(lookups).to.equal(3);

        const never = new TestHost(hostPorts({ getEnvironment: async () => undefined, environmentWaitMs: 0 }));
        const missing = await never.answer({ ...addressed, id: 'r2', kind: 'request', environmentId: 'env-x', sentAt: at(), endpoint });
        expect(!missing.ok && missing.error).to.match(/doesn't have this environment/);
    });

    it('VS Code answers only its own DBMN user, and only when signed in', async () => {
        const host = new TestHost(hostPorts());
        const message = { ...addressed, id: 'r1', kind: 'request', userId: 'someone-else', sentAt: at(), endpoint };
        const other = await host.answer(message);
        expect(other.ok).to.equal(false);
        expect(!other.ok && other.error).to.match(/different DBMN account/);

        const signedOut = await new TestHost(hostPorts({ userId: () => undefined })).answer({ ...message, userId: 'user-1' });
        expect(!signedOut.ok && signedOut.error).to.match(/signed out/);
    });

    it('a request VS Code refuses (no token, bad headers) fails the transaction with VS Code\'s reason', async () => {
        const host = new TestHost(hostPorts({ executor: { executeEndpoint: async () => { throw new Error('No authentication token available. Please authenticate first.'); } } }));
        const client = new AgentClient(vsCode(host), () => 'user-1', { signer, ...clock(), newId: () => 'r1' });
        let error: Error | undefined;
        await client.execute('env-1', endpoint).catch(e => { error = e; });
        expect(error?.message).to.equal('No authentication token available. Please authenticate first.');
    });

    it('sign-in: VS Code starts it, the web app\'s browser does the page, VS Code exchanges the code', async () => {
        let signedIn = false;
        const calls: string[] = [];
        const host = new TestHost(hostPorts({
            authGate: { isAuthenticationValid: async () => signedIn },
            oauthStart: async (_id, redirectUri) => { calls.push(`start ${redirectUri}`); return { url: 'https://login.example/authorize?state=st-1', state: 'st-1' }; },
            oauthFinish: async (_id, code, state) => { calls.push(`finish ${code} ${state}`); signedIn = true; }
        }));
        let n = 0;
        const transport = vsCode(host);
        const client = new AgentClient(transport, () => 'user-1', {
            signer, ...clock(), newId: () => `r${++n}`,
            browserSignIn: {
                redirectUri: () => WEB_APP_CALLBACK,
                run: async (url, state) => { calls.push(`browser ${url} ${state}`); return 'the-code'; }
            },
            environment: async () => environment()
        });
        expect(await client.isSignedIn('env-1')).to.equal(false);
        expect(await client.signIn('env-1')).to.equal(true);
        expect(calls).to.deep.equal([
            `start ${WEB_APP_CALLBACK}`,
            'browser https://login.example/authorize?state=st-1 st-1',
            'finish the-code st-1'
        ]);
        expect(await client.isSignedIn('env-1')).to.equal(true);
        expect(transport.crossed.map(m => m.payload).join('\n'), 'no secret crosses').to.not.match(/client_secret|code_verifier|access_token/);
    });

    it('Sign In (New Token) asks for the provider\'s login page; Sign Out signs VS Code out', async () => {
        const calls: string[] = [];
        let signedIn = true;
        const host = new TestHost(hostPorts({
            authGate: { isAuthenticationValid: async () => signedIn },
            oauthStart: async (_id, _uri, forceLogin) => { calls.push(`start forceLogin=${forceLogin}`); return { url: 'https://login.example/authorize', state: 'st' }; },
            oauthFinish: async () => { signedIn = true; },
            oauthSignOut: async () => { calls.push('sign-out'); signedIn = false; }
        }));
        let n = 0;
        const client = new AgentClient(vsCode(host), () => 'user-1', {
            signer, ...clock(), newId: () => `r${++n}`,
            browserSignIn: { redirectUri: () => WEB_APP_CALLBACK, run: async () => 'code' },
            environment: async () => environment()
        });
        await client.signOut('env-1');
        expect(await client.isSignedIn('env-1')).to.equal(false);
        expect(await client.signIn('env-1', { forceLogin: true })).to.equal(true);
        expect(calls).to.deep.equal(['sign-out', 'start forceLogin=true']);
    });

    it('a provider refusing the client (wrong secret) says where the secret is kept', async () => {
        const host = new TestHost(hostPorts({ oauthFinish: async () => { throw new Error('Token exchange failed (401): {"error":"invalid_client","error_description":"Wrong client secret"}'); } }));
        const reply = await host.answer({ ...addressed, id: 's1', kind: 'sign-in-finish', sentAt: at(), code: 'c', state: 's' });
        expect(reply.ok).to.equal(false);
        expect(!reply.ok && reply.error).to.equal('Wrong client secret. Update the client ID and secret in DBMN for VS Code (the environment\'s Authentication tab): they\'re kept there, not in the browser.');
    });

    it('never more requests in flight in an environment than its threads', async () => {
        const limiter = new EnvironmentLimiter();
        let peak = 0;
        const releases: Array<() => void> = [];
        const work = () => limiter.run('env-1', 2, async () => {
            peak = Math.max(peak, limiter.inFlight('env-1'));
            await new Promise<void>(resolve => releases.push(resolve));
        });
        const all = Promise.all([work(), work(), work(), work(), work()]);
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setImmediate(resolve));
            releases.shift()?.();
        }
        await all;
        expect(peak).to.equal(2);
        expect(limiter.inFlight('env-1')).to.equal(0);
    });

    it('an environment\'s threads: its parallel setting, else one', () => {
        expect(environmentThreads(undefined)).to.equal(1);
        expect(environmentThreads({ parallelProcessing: { enabled: false, maxConcurrency: 8 } })).to.equal(1);
        expect(environmentThreads({ parallelProcessing: { enabled: true, maxConcurrency: 4 } })).to.equal(4);
    });

    describe('#375: nothing that arrives is trusted', () => {
        const request = (overrides: Record<string, unknown> = {}) => ({ ...addressed, id: 'r1', kind: 'request', sentAt: at(), endpoint, ...overrides });
        /** A host that counts what it sends. */
        const counting = (overrides: Partial<AgentHostPorts> = {}) => {
            const sent: string[] = [];
            const host = new TestHost(hostPorts({ executor: { executeEndpoint: async e => { sent.push(e.path); return ok(); } }, ...overrides }));
            return { host, sent };
        };

        it('every reply says which protocol it speaks and which DBMN for VS Code sent it', async () => {
            const { host } = counting({ agentVersion: '0.4.0' });
            const reply = await host.answer(request());
            expect(reply.ok, JSON.stringify(reply)).to.equal(true);
            expect(reply.v).to.equal(AGENT_PROTOCOL_VERSION);
            expect(reply.agentVersion).to.equal('0.4.0');
            expect(host.refusal('r9', 'unreadable')).to.deep.equal({ id: 'r9', ok: false, error: 'unreadable', v: AGENT_PROTOCOL_VERSION, agentVersion: '0.4.0' });
        });

        it('a newer web app\'s message: "Update DBMN for VS Code"; one with no version: reload the page. Nothing is sent', async () => {
            const { host, sent } = counting();
            const newer = await host.answer(request({ v: AGENT_PROTOCOL_VERSION + 1 }));
            expect(newer).to.include({ ok: false, error: UPDATE_VSCODE, code: 'version', id: 'r1' });
            const { v: _none, ...unversioned } = request();
            const older = await host.answer(unversioned);
            expect(older).to.include({ ok: false, error: RELOAD_WEB_APP, code: 'version' });
            expect(sent).to.deep.equal([]);
        });

        it('a message that isn\'t the shape it should be is refused, never acted on', async () => {
            const { host, sent } = counting();
            const refused = async (message: unknown) => {
                const reply = await host.answer(message);
                expect(reply.ok, JSON.stringify(message)).to.equal(false);
                return reply.ok ? '' : reply.error;
            };
            expect(await refused(request({ kind: 'delete-everything' }))).to.match(/refused this request: "kind"/);
            expect(await refused(request({ id: 'r1/../x' }))).to.match(/"id"/);
            expect(await refused(request({ to: '../listener' }))).to.match(/"to"/);
            expect(await refused(request({ endpoint: undefined }))).to.match(/"endpoint"/);
            expect(await refused(request({ endpoint: { method: 'GET' } }))).to.match(/"endpoint.path"/);
            expect(await refused(request({ sentAt: 'yesterday' }))).to.match(/"sentAt"/);
            expect(await refused({ ...addressed, id: 's1', kind: 'sign-in-start', sentAt: at(), redirectUri: 'not a url' })).to.match(/"redirectUri"/);
            expect(await refused('{"kind":"request"}')).to.equal(RELOAD_WEB_APP);
            expect(await refused(null)).to.equal(RELOAD_WEB_APP);
            expect(sent).to.deep.equal([]);
        });

        it('only the options the agent uses cross: the rest is dropped', async () => {
            let options: unknown;
            const host = new TestHost(hostPorts({ executor: { executeEndpoint: async (_e, _s, _id, o) => { options = o; return ok(); } } }));
            await host.answer(request({ options: { isBatchMember: true, executionId: 'x1', somethingElse: 'rm -rf' } }));
            expect(options).to.deep.equal({ isBatchMember: true, executionId: 'x1' });
        });

        it('a request stamped longer ago than ALIVE_MS (or ahead by as much) is refused as stale, unsent', async () => {
            const { host, sent } = counting();
            fakeNow = 10 * 60_000;
            expect(await host.answer(request({ sentAt: at(ALIVE_MS + 1) }))).to.include({ ok: false, error: AGENT_STALE, code: 'stale' });
            expect(await host.answer(request({ sentAt: at(-ALIVE_MS - 1) }))).to.include({ ok: false, code: 'stale' });
            expect((await host.answer(request({ sentAt: at(ALIVE_MS - 1) }))).ok).to.equal(true);
            expect(sent).to.deep.equal(['/carriers']);
        });

        it('any environment VS Code holds is run for its account\'s web app: "Run in" is the web app\'s to route by, not VS Code\'s to check', async () => {
            const browserRun = environment({ id: 'env-2', name: 'Browser-run', runOn: undefined });
            const { host, sent } = counting({ getEnvironment: async () => browserRun });
            expect((await host.answer(request({ environmentId: 'env-2' }))).ok).to.equal(true);
            expect(sent).to.deep.equal(['/carriers']);
        });

        it('production set to run here is sent: the web app asks, VS Code stays in the background', async () => {
            const { host, sent } = counting({ getEnvironment: async () => environment({ name: 'Live', environmentType: 'production' }) });
            expect((await host.answer(request())).ok).to.equal(true);
            expect(sent.length).to.equal(1);
        });

        it('sign-in comes back only to the web app\'s own callback page (a dev build: a local dev server\'s too)', async () => {
            let started = 0;
            const start = (redirectUri: string, devBuild = false) => new TestHost(hostPorts({ devBuild: () => devBuild, oauthStart: async () => { started++; return { url: 'https://login.example/authorize', state: 'st' }; } }))
                .answer({ ...addressed, id: 's1', kind: 'sign-in-start', sentAt: at(), redirectUri });
            expect(await start('https://evil.example/oauth-callback.html')).to.include({ ok: false, error: AGENT_REDIRECT_REFUSED });
            expect(await start('http://127.0.0.1:5180/oauth-callback.html'), 'a packaged build').to.include({ ok: false, error: AGENT_REDIRECT_REFUSED });
            expect(started).to.equal(0);
            expect((await start(WEB_APP_CALLBACK)).ok).to.equal(true);
            expect((await start('http://127.0.0.1:5180/oauth-callback.html', true)).ok).to.equal(true);

            expect(isAllowedRedirectUri('https://app.dbmn.io/oauth-callback.html?x=1', true)).to.equal(false);
            expect(isAllowedRedirectUri('https://app.dbmn.io.evil.example/oauth-callback.html', true)).to.equal(false);
            expect(isAllowedRedirectUri('http://127.0.0.1:5180/other.html', true)).to.equal(false);
            expect(isAllowedRedirectUri('http://localhost:5180/oauth-callback.html', true)).to.equal(false);
            expect(isAllowedRedirectUri('http://user@127.0.0.1:5180/oauth-callback.html', true)).to.equal(false);
        });

        it('the web app opens only a sign-in page on the environment\'s own authorize host', async () => {
            const opened: string[] = [];
            const signIn = async (url: string, env: EnvironmentConfig | null = environment()) => {
                const host = new TestHost(hostPorts({ oauthStart: async () => ({ url, state: 'st' }) }));
                let n = 0;
                const client = new AgentClient(vsCode(host), () => 'user-1', {
                    signer, ...clock(), newId: () => `r${++n}`,
                    browserSignIn: { redirectUri: () => WEB_APP_CALLBACK, run: async page => { opened.push(page); return 'code'; } },
                    environment: async () => env ?? undefined
                });
                return client.signIn('env-1').then(() => 'signed in', (e: Error) => e.message);
            };
            expect(await signIn('https://evil.example/authorize?client_id=x')).to.equal(AGENT_SIGN_IN_PAGE_REFUSED);
            expect(await signIn('javascript:alert(1)')).to.match(/can't read|isn't on this environment/);
            expect(await signIn('https://login.example/authorize?state=st', null), 'an environment the web app doesn\'t have').to.equal(AGENT_SIGN_IN_PAGE_REFUSED);
            expect(opened).to.deep.equal([]);
            expect(await signIn('https://login.example/authorize?state=st')).to.equal('signed in');
            expect(opened).to.deep.equal(['https://login.example/authorize?state=st']);

            // A relative authorize page is on the environment's base URL
            const relative = { baseUrl: 'https://api.example/v2', oauthConfig: { authorizationUrl: '/oauth/authorize' } };
            expect(isEnvironmentSignInUrl('https://api.example/oauth/authorize?x=1', relative)).to.equal(true);
            expect(isEnvironmentSignInUrl('https://api.example.evil.test/oauth/authorize', relative)).to.equal(false);
        });

        it('the web app reads a reply like anything else from outside: versioned, parsed, and its own', async () => {
            const answerWith = async (reply: (id: string) => unknown) => {
                const transport: AgentTransport = { connect: async () => ({ listenerId: LISTENER, send: async message => reply(message.id) }) };
                const client = new AgentClient(transport, () => 'user-1', { signer, ...clock(), newId: () => 'r1' });
                return client.execute('env-1', endpoint).then(r => `status ${r.status}`, (e: Error) => e.message);
            };
            expect(await answerWith(id => ({ id, ok: true, response: ok() })), 'an agent from before versions').to.equal(UPDATE_VSCODE);
            expect(await answerWith(id => ({ id, v: AGENT_PROTOCOL_VERSION + 1, ok: true, response: ok() })), 'an agent newer than this page').to.equal(RELOAD_WEB_APP);
            expect(await answerWith(id => ({ id, v: 1, ok: 'yes' }))).to.match(/can't read/);
            expect(await answerWith(() => ({ id: 'someone-elses', v: 1, ok: true, response: ok() }))).to.match(/can't read/);
            expect(await answerWith(id => ({ id, v: 1, ok: true, response: ok(204) }))).to.equal('status 204');
        });
    });

    describe('who is asking: only what this account\'s web app signed is acted on', () => {
        const request = (overrides: Record<string, unknown> = {}) => ({ ...addressed, id: 'r1', kind: 'request', sentAt: at(), endpoint, ...overrides });
        const counting = (overrides: Partial<AgentHostPorts> = {}) => {
            const sent: string[] = [];
            const host = new AgentHost(hostPorts({ executor: { executeEndpoint: async e => { sent.push(e.path); return ok(); } }, ...overrides }));
            return { host, sent };
        };

        it('a signature is the key holder\'s, over exactly those bytes', async () => {
            const signature = await signer.sign('{"a":1}');
            expect(await verifyAgentSignature(signer.publicKey, '{"a":1}', signature)).to.equal(true);
            expect(await verifyAgentSignature(signer.publicKey, '{"a":2}', signature), 'other bytes').to.equal(false);
            const other = await agentSigner(await newAgentKeyPair());
            expect(await verifyAgentSignature(other.publicKey, '{"a":1}', signature), 'another key').to.equal(false);
            expect(await verifyAgentSignature('not a key', '{"a":1}', signature)).to.equal(false);
            expect(await verifyAgentSignature(signer.publicKey, '{"a":1}', 'not+a/signature')).to.equal(false);
            expect(signer.keyId, 'a key is named by its own hash').to.equal(await agentKeyId(signer.publicKey));
            expect(signer.keyId).to.match(/^[A-Za-z0-9_-]{43}$/);
        });

        it('signed by this account\'s web app: sent', async () => {
            const { host, sent } = counting();
            expect((await host.answer(await sealed(request()), LISTENER)).ok).to.equal(true);
            expect(sent).to.deep.equal(['/carriers']);
        });

        it('not signed at all (a page from before signing, or anything else that called): reload, nothing sent', async () => {
            const { host, sent } = counting();
            expect(await host.answer(request(), LISTENER)).to.include({ ok: false, error: RELOAD_WEB_APP, id: 'r1' });
            expect(sent).to.deep.equal([]);
        });

        it('a key VS Code\'s account doesn\'t have: refused as an unknown browser', async () => {
            const stranger = await agentSigner(await newAgentKeyPair());
            const { host, sent } = counting();
            expect(await host.answer(await sealed(request(), stranger), LISTENER)).to.include({ ok: false, error: AGENT_UNKNOWN_BROWSER, code: 'unknown-key' });
            expect(sent).to.deep.equal([]);
        });

        it('changed after it was signed, or signed by another key under this one\'s name: refused', async () => {
            const { host, sent } = counting();
            const good = await sealed(request());
            const edited = { ...good, payload: good.payload.replace('/carriers', '/carriers/delete-all') };
            expect(await host.answer(edited, LISTENER)).to.include({ ok: false, error: AGENT_NOT_SIGNED });
            const stranger = await agentSigner(await newAgentKeyPair());
            const forged = await sealed(request(), { keyId: signer.keyId, sign: stranger.sign });
            expect(await host.answer(forged, LISTENER)).to.include({ ok: false, error: AGENT_NOT_SIGNED });
            // The envelope can't point a signed message at another request's reply
            expect((await host.answer({ ...good, id: 'r2' }, LISTENER)).ok).to.equal(false);
            expect(sent).to.deep.equal([]);
        });

        it('a signed message is good once: a copy sent again while it\'s still fresh is refused', async () => {
            const { host, sent } = counting();
            const message = await sealed(request());
            expect((await host.answer(message, LISTENER)).ok).to.equal(true);
            expect(await host.answer(message, LISTENER)).to.include({ ok: false, error: AGENT_ANSWERED_BEFORE });
            expect(sent).to.deep.equal(['/carriers']);
        });

        it('...and only at the listener it names: a copy played to another VS Code window is refused there', async () => {
            const { host, sent } = counting();
            const message = await sealed(request());
            expect(await host.answer(message, 'listener-2')).to.include({ ok: false, error: AGENT_WRONG_LISTENER, code: 'wrong-listener' });
            expect(sent).to.deep.equal([]);
        });

        it('the window it was for has gone and another answers in its place: the web app looks again and sends to the one that\'s there', async () => {
            const { host, sent } = counting();
            let lookedAgain = false;
            const fresh: boolean[] = [];
            const inner = vsCode(host);
            const transport: AgentTransport = {
                connect: async again => {
                    fresh.push(!!again);
                    if (again) lookedAgain = true;
                    const connection = await inner.connect();
                    // Before looking again the web app still names the window that has gone
                    return connection && { ...connection, listenerId: lookedAgain ? LISTENER : 'listener-gone' };
                }
            };
            let n = 0;
            const client = new AgentClient(transport, () => 'user-1', { signer, ...clock(), newId: () => `r${++n}` });
            expect((await client.execute('env-1', endpoint)).status).to.equal(200);
            expect(fresh, 'the second look doesn\'t reuse what was found before').to.deep.equal([false, true]);
            expect(sent, 'sent once').to.deep.equal(['/carriers']);
        });

        it('VS Code can\'t reach the account to look the key up: refused with why, nothing sent', async () => {
            const { host, sent } = counting({ publicKey: async () => { throw new Error('could not read your DBMN account\'s keys (offline)'); } });
            const reply = await host.answer(await sealed(request()), LISTENER);
            expect(!reply.ok && reply.error).to.match(/could not read your DBMN account's keys/);
            expect(sent).to.deep.equal([]);
        });

        it('VS Code doesn\'t know this browser yet: the web app registers its key again and sends again, once', async () => {
            let onAccount = false;
            let registrations = 0;
            const sent: string[] = [];
            const host = new AgentHost(hostPorts({
                publicKey: async keyId => (onAccount && keyId === signer.keyId ? signer.publicKey : undefined),
                executor: { executeEndpoint: async e => { sent.push(e.path); return ok(); } }
            }));
            let n = 0;
            const registering: AgentSigner = { ...signer, register: async () => { registrations++; onAccount = true; } };
            const client = new AgentClient(vsCode(host), () => 'user-1', { signer: registering, ...clock(), newId: () => `r${++n}` });
            expect((await client.execute('env-1', endpoint)).status).to.equal(200);
            expect(registrations).to.equal(1);
            expect(sent).to.deep.equal(['/carriers']);

            // Still unknown after registering (another account's VS Code): said, not tried forever
            const never = new AgentHost(hostPorts({ publicKey: async () => undefined }));
            const lost = new AgentClient(vsCode(never), () => 'user-1', { signer: registering, ...clock(), newId: () => `q${++n}` });
            expect(await lost.execute('env-1', endpoint).then(() => 'sent', (e: Error) => e.message)).to.equal(AGENT_UNKNOWN_BROWSER);
            expect(registrations).to.equal(2);
        });

        it('a web app with no key sends nothing', async () => {
            const transport = vsCode(new TestHost(hostPorts()));
            const client = new AgentClient(transport, () => 'user-1', { ...clock(), newId: () => 'r1' });
            expect(await client.execute('env-1', endpoint).then(() => 'sent', (e: Error) => e.message)).to.equal(RELOAD_WEB_APP);
            expect(transport.crossed).to.deep.equal([]);
        });

        it('what the web app sends is the envelope: the message as JSON, and its signature', async () => {
            const message = { ...addressed, id: 'r1', kind: 'auth-status', sentAt: at() } as AgentMessage;
            const envelope = await signAgentMessage(message, signer);
            expect(envelope).to.include({ v: AGENT_PROTOCOL_VERSION, id: 'r1', keyId: signer.keyId, payload: JSON.stringify(message) });
            expect(await verifyAgentSignature(signer.publicKey, envelope.payload, envelope.signature)).to.equal(true);
        });
    });

    describe('in the web app', () => {
        const environments = (env: Partial<EnvironmentConfig>) => ({
            getEnvironment: async () => environment(env),
            getActiveEnvironment: async () => environment(env)
        });

        it('routes by the environment\'s "Run in"', async () => {
            const used: string[] = [];
            const browser: IRequestExecutor = { executeEndpoint: async () => { used.push('browser'); return ok(); } };
            const agent = { execute: async () => { used.push('agent'); return ok(); } };
            await routeByEnvironment({ environments: environments({ runOn: 'local-agent' }), browser, agent }).executeEndpoint(endpoint, undefined, 'env-1');
            await routeByEnvironment({ environments: environments({ runOn: undefined }), browser, agent }).executeEndpoint(endpoint, undefined, 'env-1');
            expect(used).to.deep.equal(['agent', 'browser']);
        });

        it('a single run checks first (wait for VS Code, sign-in); a batch member doesn\'t (its batch did)', async () => {
            const checked: string[] = [];
            const route = routeByEnvironment({
                environments: environments({ runOn: 'local-agent' }), browser: { executeEndpoint: async () => ok() },
                agent: { execute: async () => ok() },
                beforeAgentRequest: async (env, _signal, options) => { checked.push(`${env.id} ${options?.executionId ?? 'member'}`); }
            });
            await route.executeEndpoint(endpoint, undefined, 'env-1', { executionId: 'exec-1' });
            await route.executeEndpoint(endpoint, undefined, 'env-1', { isBatchMember: true, executionId: 'exec-2' });
            expect(checked).to.deep.equal(['env-1 exec-1']);
        });

        it('VS Code closing mid-request is a failed request (listed under Errors), not a crash; other failures still throw', async () => {
            const lost = routeByEnvironment({
                environments: environments({ runOn: 'local-agent' }), browser: { executeEndpoint: async () => ok() },
                agent: { execute: async () => { throw new Error(AGENT_LOST); } }
            });
            const response = await lost.executeEndpoint(endpoint, undefined, 'env-1', { isBatchMember: true });
            expect(response).to.deep.include({ success: false, status: undefined, error: AGENT_LOST, url: 'https://api.example/carriers' });
            expect(isAgentLost(response.error)).to.equal(true);

            const refused = routeByEnvironment({
                environments: environments({ runOn: 'local-agent' }), browser: { executeEndpoint: async () => ok() },
                agent: { execute: async () => { throw new Error('DBMN for VS Code didn\'t take this request (500).'); } }
            });
            let error: Error | undefined;
            await refused.executeEndpoint(endpoint, undefined, 'env-1', { isBatchMember: true }).catch(e => { error = e; });
            expect(error?.message).to.match(/didn't take this request/);
        });

        it('a single run whose check fails sends nothing', async () => {
            let sent = false;
            const route = routeByEnvironment({
                environments: environments({ runOn: 'local-agent' }), browser: { executeEndpoint: async () => ok() },
                agent: { execute: async () => { sent = true; return ok(); } },
                beforeAgentRequest: async () => { throw new Error('Not signed in to Staging in VS Code: sign in and run it again.'); }
            });
            let error: Error | undefined;
            await route.executeEndpoint(endpoint, undefined, 'env-1').catch(e => { error = e; });
            expect(error?.message).to.match(/Not signed in/);
            expect(sent).to.equal(false);
        });

        const networkError: IRequestExecutor = { executeEndpoint: async () => ({ success: false, statusText: 'Network error: Failed to fetch', error: 'Network error: Failed to fetch', data: null, duration: 1, url: 'https://api.example/carriers' }) };

        it('#356: a server that answers, but not to a browser, is a CORS block: says to run it in VS Code', async () => {
            const asked: string[] = [];
            const response = await routeByEnvironment({ environments: environments({ runOn: undefined }), browser: networkError, agent: { execute: async () => ok() }, reachable: async url => { asked.push(url); return true; } })
                .executeEndpoint(endpoint, undefined, 'env-1');
            expect(asked).to.deep.equal(['https://api.example/carriers']);
            expect(response.error).to.equal(BROWSER_BLOCKED);
        });

        it('#356: no server at all is still a network error', async () => {
            const response = await routeByEnvironment({ environments: environments({ runOn: undefined }), browser: networkError, agent: { execute: async () => ok() }, reachable: async () => false })
                .executeEndpoint(endpoint, undefined, 'env-1');
            expect(response.error).to.equal('Network error: Failed to fetch');
        });

        it('the gate asks VS Code for local-agent environments, and Sign In signs in there', async () => {
            const inner: IEnvironmentAuthGate = {
                isAuthenticationValid: async () => { throw new Error('not for agent environments'); },
                ensureAuthenticated: async () => { throw new Error('not for agent environments'); },
                ensureAuthenticatedForBatch: async () => { throw new Error('not for agent environments'); }
            };
            const calls: string[] = [];
            const agent = {
                connected: async () => true,
                isSignedIn: async () => { calls.push('status'); return false; },
                signIn: async () => { calls.push('sign-in'); return true; }
            };
            const modal = { showModal: async () => ({ actionId: 'sign-in' }) } as unknown as ModalHost;
            const toasts: string[] = [];
            const gate = agentAwareAuthGate(inner, agent, { environments: environments({}), modal: () => modal, toast: { info: m => toasts.push(m), error: m => toasts.push(`error: ${m}`) } });
            expect(await gate.ensureAuthenticated(environment())).to.equal(true);
            expect(calls).to.deep.equal(['status', 'sign-in']);
            expect(toasts, 'says who signs in').to.deep.equal(['Signing in to Staging through DBMN for VS Code…', 'Signed in to Staging through DBMN for VS Code.']);
        });

        it('VS Code isn\'t there: the gate lets the run go ahead, queued, and says it\'s waiting', async () => {
            const said: string[] = [];
            const agent = { connected: async () => false, isSignedIn: async () => { throw new Error('not asked'); }, signIn: async () => true };
            const inner = {} as IEnvironmentAuthGate;
            const gate = agentAwareAuthGate(inner, agent, { environments: environments({}), modal: () => ({}) as ModalHost, toast: { info: m => said.push(m), error: m => said.push(`error: ${m}`) } });
            expect(await gate.ensureAuthenticated(environment())).to.equal(true);
            expect(said).to.deep.equal([AGENT_WAITING]);
        });
    });
});
