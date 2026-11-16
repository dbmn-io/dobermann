// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #374: the web app's side of the loopback connection, without a browser: finding the listener
 * on the account, the browser's permission, and what's said when it can't get through.
 */
import { expect } from 'chai';
import type { AgentListener } from '../../../services/agent/agent-listener';
import { AGENT_HELLO_PATH, AGENT_MESSAGE_PATH } from '../../../services/agent/agent-http';
import { AGENT_BROWSER_BLOCKED, AGENT_SAFARI, loopbackTransport, type LoopbackDeps, type LoopbackFetchInit, type LoopbackPermission } from '../../../services/agent/agent-loopback';
import { AGENT_LOST } from '../../../services/agent/local-agent';
import { UNREADABLE_REPLY, type SignedAgentMessage } from '../../../services/agent/agent-protocol';

const listener = (listenerId: string, port: number): AgentListener => ({ listenerId, port, deviceId: 'laptop', agentVersion: '0.4.0', updatedAt: '2026-10-11T00:00:00Z' });
const message = { v: 1, id: 'r1', keyId: 'k', payload: '{}', signature: 's' } as SignedAgentMessage;

describe('The web app reaching DBMN for VS Code over loopback (#374)', () => {
    /** Which ports answer hello, and as whom. */
    let open: Map<number, string>;
    let account: AgentListener[];
    let calls: string[];
    let said: string[];
    let explained: number;
    let time: number;
    let accountAsked: number;

    const deps = (overrides: Partial<LoopbackDeps> = {}): LoopbackDeps => ({
        listeners: async () => { accountAsked++; return account; },
        fetch: async (url: string, init?: LoopbackFetchInit) => {
            const { port, pathname } = new URL(url);
            calls.push(`${init?.method ?? 'GET'} ${port}${pathname}`);
            const who = open.get(Number(port));
            if (!who) throw new TypeError('Failed to fetch');
            if (pathname === AGENT_HELLO_PATH) return { ok: true, status: 200, json: async () => ({ v: 1, listenerId: who }) };
            return { ok: true, status: 200, json: async () => ({ id: (JSON.parse(init?.body ?? '{}') as { id: string }).id, ok: true, v: 1 }) };
        },
        permission: async () => 'unknown',
        explain: async () => { explained++; return true; },
        say: text => said.push(text),
        now: () => time,
        ...overrides
    });

    beforeEach(() => {
        open = new Map([[51001, 'window-1']]);
        account = [listener('window-1', 51001)];
        calls = []; said = []; explained = 0; time = 0; accountAsked = 0;
    });

    it('finds the listener VS Code announced on the account, and sends to it', async () => {
        const connection = await loopbackTransport(deps()).connect();
        expect(connection?.listenerId).to.equal('window-1');
        expect(await connection?.send(message)).to.deep.equal({ id: 'r1', ok: true, v: 1 });
        expect(calls).to.deep.equal([`GET 51001${AGENT_HELLO_PATH}`, `POST 51001${AGENT_MESSAGE_PATH}`]);
        expect(explained, 'no prompt where the browser asks nothing').to.equal(0);
    });

    it('nothing on the account: VS Code isn\'t open. The browser is asked for nothing', async () => {
        account = [];
        expect(await loopbackTransport(deps({ permission: async () => 'prompt' })).connect()).to.equal(undefined);
        expect(calls).to.deep.equal([]);
        expect(explained).to.equal(0);
    });

    it('the newest listener that answers as itself is used: a closed window, and a port something else took, are passed over', async () => {
        account = [listener('window-closed', 51003), listener('window-old', 51002), listener('window-1', 51001)];
        open.set(51002, 'something-else');
        expect((await loopbackTransport(deps()).connect())?.listenerId).to.equal('window-1');
    });

    it('what answered is remembered for a few seconds; "nobody there" is asked again every few seconds, then less often', async () => {
        const transport = loopbackTransport(deps());
        await transport.connect();
        await transport.connect();
        expect(accountAsked, 'a batch doesn\'t ask the account before every request').to.equal(1);
        time += 6_000;
        await transport.connect();
        expect(accountAsked).to.equal(2);
        await transport.connect(true);
        expect(accountAsked, 'looking again never reuses').to.equal(3);

        // VS Code closes: a waiting run asks every second, the account every few
        account = [];
        time += 6_000;
        const before = accountAsked;
        for (let second = 0; second < 30; second++) { await transport.connect(); time += 1_000; }
        expect(accountAsked - before).to.be.within(9, 11);
        time += 3 * 60_000;
        const later = accountAsked;
        for (let second = 0; second < 30; second++) { await transport.connect(); time += 1_000; }
        expect(accountAsked - later, 'left waiting: less often').to.be.within(2, 4);
    });

    it('the browser will ask: DBMN says why first, once; Cancel there asks nothing of the browser, and not again straight away', async () => {
        let permission: LoopbackPermission = 'prompt';
        let answer = true;
        const transport = loopbackTransport(deps({ permission: async () => permission, explain: async () => { explained++; return answer; } }));
        expect((await transport.connect())?.listenerId, 'Continue: on to the browser\'s own prompt').to.equal('window-1');
        expect(explained).to.equal(1);
        permission = 'granted';
        time += 10_000;
        await transport.connect();
        expect(explained, 'allowed: never explained again').to.equal(1);

        const cancelling = loopbackTransport(deps({ permission: async () => 'prompt', explain: async () => { explained++; return answer; } }));
        answer = false;
        calls = [];
        expect(await cancelling.connect()).to.equal(undefined);
        expect(calls, 'the browser was asked nothing').to.deep.equal([]);
        time += 5_000;
        await cancelling.connect(true);
        expect(explained, 'a waiting run doesn\'t bring it back every second').to.equal(2);
        time += 31_000;
        answer = true;
        expect((await cancelling.connect())?.listenerId, 'asked again later').to.equal('window-1');
        expect(explained).to.equal(3);

        // Continue, then the browser's own prompt closed unanswered (still "prompt", nothing reachable):
        // the explainer doesn't come back every few seconds either
        open.clear();
        explained = 0;
        const dismissing = loopbackTransport(deps({ permission: async () => 'prompt', explain: async () => { explained++; return true; } }));
        expect(await dismissing.connect()).to.equal(undefined);
        time += 5_000;
        expect(await dismissing.connect(true)).to.equal(undefined);
        expect(explained).to.equal(1);
        time += 31_000;
        await dismissing.connect(true);
        expect(explained, 'again once some time has passed').to.equal(2);
    });

    it('the browser is blocking it: said once, with where to change it; nothing is tried', async () => {
        const transport = loopbackTransport(deps({ permission: async () => 'denied' }));
        expect(await transport.connect()).to.equal(undefined);
        await transport.connect(true);
        expect(said).to.deep.equal([AGENT_BROWSER_BLOCKED]);
        expect(calls).to.deep.equal([]);
    });

    it('Safari, with VS Code announced but unreachable: said once', async () => {
        open.clear();
        const transport = loopbackTransport(deps({ blocksLoopback: true }));
        expect(await transport.connect()).to.equal(undefined);
        await transport.connect(true);
        expect(said).to.deep.equal([AGENT_SAFARI]);
        expect((await loopbackTransport(deps()).connect()), 'another browser: VS Code just isn\'t answering').to.equal(undefined);
        expect(said.length).to.equal(1);
    });

    it('the connection goes before the answer: nobody knows if it was sent, and the listener is looked up again', async () => {
        const transport = loopbackTransport(deps());
        const connection = await transport.connect();
        open.clear();
        expect(await connection!.send(message).then(() => 'answered', (e: Error) => e.message)).to.equal(AGENT_LOST);
        open.set(51001, 'window-1');
        const asked = accountAsked;
        await transport.connect();
        expect(accountAsked, 'not the remembered one').to.equal(asked + 1);
    });

    it('an answer that isn\'t JSON, or a refusal to take the message at all, says to update VS Code', async () => {
        const answering = (response: { ok: boolean; status: number; json(): Promise<unknown> }) => loopbackTransport(deps({
            fetch: async url => (url.endsWith(AGENT_HELLO_PATH) ? { ok: true, status: 200, json: async () => ({ listenerId: 'window-1' }) } : response)
        })).connect().then(connection => connection!.send(message)).then(() => 'answered', (e: Error) => e.message);
        expect(await answering({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } })).to.equal(UNREADABLE_REPLY);
        expect(await answering({ ok: false, status: 404, json: async () => ({}) })).to.match(/didn't take this request \(404\)/);
    });

    it('hanging up is a cancel, not a lost connection; the account unreachable keeps what answered last', async () => {
        const hangUp = new AbortController();
        const transport = loopbackTransport(deps({
            fetch: async (url, init) => {
                if (url.endsWith(AGENT_HELLO_PATH)) return { ok: true, status: 200, json: async () => ({ listenerId: 'window-1' }) };
                hangUp.abort();
                throw Object.assign(new Error('aborted'), { name: 'AbortError', init });
            }
        }));
        const connection = await transport.connect();
        const error = await connection!.send(message, hangUp.signal).catch(e => e as Error);
        expect((error as Error).name).to.equal('AbortError');

        let offline = false;
        const flaky = loopbackTransport(deps({ listeners: async () => { if (offline) throw new Error('offline'); return account; } }));
        expect((await flaky.connect())?.listenerId).to.equal('window-1');
        offline = true;
        expect((await flaky.connect(true))?.listenerId, 'the account can\'t be asked: the listener that answered is still used').to.equal('window-1');
    });
});
