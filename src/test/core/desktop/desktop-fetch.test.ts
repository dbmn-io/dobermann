// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #392: the desktop app's requests go from its main process, not its window. Both halves,
 * joined the way IPC joins them (a structured clone each way), against a real local server
 * that sends no CORS header: the answer a browser would be kept from.
 */
import { expect } from 'chai';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { bridgeFetch, desktopFetcher, type DesktopFetcher } from '../../../services/desktop/desktop-fetch';
import type { DesktopBridge, DesktopFetchRequest } from '../../../services/desktop/desktop-protocol';
import { FetchRequestExecutor } from '../../../services/execution/fetch-request-executor';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import type { IExtensionDiagnosticLogger } from '../../../services/logging/extension-diagnostic-logger.interface';

const logger = { info: () => undefined, debug: () => undefined, trace: () => undefined, warn: () => undefined, error: () => undefined, show: () => undefined, clear: () => undefined, dispose: () => undefined } as IExtensionDiagnosticLogger;

describe('The desktop app sends requests from its main process (#392)', () => {
    let server: http.Server;
    let base: string;
    const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    let closedEarly = 0;

    before(async () => {
        server = http.createServer((request, response) => {
            let body = '';
            request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                seen.push({ method: request.method, url: request.url, headers: request.headers, body });
                if (request.url === '/slow') {
                    response.on('close', () => { if (!response.writableEnded) closedEarly++; });
                    return;   // never answers: Cancel is the only way out
                }
                if (request.url === '/empty') { response.writeHead(204).end(); return; }
                // No Access-Control-Allow-Origin: a page's fetch would be refused this answer
                response.writeHead(request.url === '/missing' ? 404 : 200, { 'Content-Type': 'application/json', 'X-Total-Count': '2' });
                response.end(JSON.stringify({ carriers: ['DHL', 'UPS'], got: body }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => { server.closeAllConnections(); server.close(); });
    beforeEach(() => { seen.length = 0; closedEarly = 0; });

    let main: DesktopFetcher;
    /** What the preload does: each call crosses as a copy, never by reference. */
    const bridge = (): Pick<DesktopBridge, 'fetch' | 'cancelFetch'> => {
        main = desktopFetcher({ fetch });
        return {
            fetch: request => main.fetch(structuredClone(request)).then(reply => structuredClone(reply)),
            cancelFetch: id => main.cancel(structuredClone({ id }))
        };
    };

    it('a request goes out with its method, headers and body, and its answer comes back whole', async () => {
        const response = await bridgeFetch(bridge())(`${base}/carriers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t0ken' }, body: '{"a":1}' });
        expect(response.status).to.equal(200);
        expect(response.headers.get('x-total-count')).to.equal('2');
        expect(await response.json()).to.deep.equal({ carriers: ['DHL', 'UPS'], got: '{"a":1}' });
        expect(seen[0].method).to.equal('POST');
        expect(seen[0].headers.authorization).to.equal('Bearer t0ken');
        expect(seen[0].headers.origin, 'not a browser\'s request: no Origin, so no CORS').to.equal(undefined);
    });

    it('an error status is an answer, not a failure; a status with no body has none', async () => {
        const missing = await bridgeFetch(bridge())(`${base}/missing`, { method: 'GET' });
        expect(missing.status).to.equal(404);
        expect(missing.ok).to.equal(false);
        const empty = await bridgeFetch(bridge())(`${base}/empty`, { method: 'DELETE' });
        expect(empty.status).to.equal(204);
        expect(await empty.text()).to.equal('');
    });

    it('nothing listening reads as fetch reports it: a TypeError the executor words as a network error', async () => {
        const dead = http.createServer();
        await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve));
        const port = (dead.address() as AddressInfo).port;
        await new Promise(resolve => dead.close(resolve));
        const failure = await bridgeFetch(bridge())(`http://127.0.0.1:${port}/x`, { method: 'GET' }).then(() => undefined, (error: unknown) => error);
        expect(failure).to.be.instanceOf(TypeError);
        expect((failure as Error).message).to.match(/^fetch failed: /);
    });

    it('Cancel aborts the request in flight, in the main process too', async () => {
        const controller = new AbortController();
        const pending = bridgeFetch(bridge())(`${base}/slow`, { method: 'GET', signal: controller.signal }).then(() => undefined, (error: unknown) => error);
        while (seen.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
        controller.abort();
        const failure = await pending as Error;
        expect(failure.name).to.equal('AbortError');
        while (closedEarly === 0) await new Promise(resolve => setTimeout(resolve, 10));
        expect(closedEarly, 'the connection was dropped, not left to finish').to.equal(1);
    });

    it('already cancelled: nothing is sent', async () => {
        const controller = new AbortController();
        controller.abort();
        const failure = await bridgeFetch(bridge())(`${base}/carriers`, { method: 'GET', signal: controller.signal }).then(() => undefined, (error: unknown) => error) as Error;
        expect(failure.name).to.equal('AbortError');
        expect(seen).to.have.length(0);
    });

    it('a closing window cancels everything it asked for', async () => {
        const pending = bridgeFetch(bridge())(`${base}/slow`, { method: 'GET' }).then(() => undefined, (error: unknown) => error);
        while (seen.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
        main.cancelAll();
        expect((await pending as Error).name).to.equal('AbortError');
    });

    describe('the main process trusts nothing the window sends', () => {
        const valid: DesktopFetchRequest = { id: '0b0e7a52-5b1e-4f6e-9d0a-3f1f0e6f5a11', url: 'http://127.0.0.1:1/x', method: 'GET', headers: {} };
        const refused = async (raw: unknown) => {
            const reply = await desktopFetcher({ fetch: async () => { throw new Error('sent'); } }).fetch(raw);
            return !reply.ok && reply.error === 'Not a request.';
        };

        it('refuses anything that is not a request, without sending', async () => {
            expect(await refused(undefined)).to.equal(true);
            expect(await refused('GET /')).to.equal(true);
            expect(await refused({ ...valid, id: 'not-a-uuid' })).to.equal(true);
            expect(await refused({ ...valid, method: 'CONNECT' })).to.equal(true);
            expect(await refused({ ...valid, headers: { a: 1 } })).to.equal(true);
            expect(await refused({ ...valid, extra: true }), 'unknown fields are refused, not ignored').to.equal(true);
        });

        it('refuses anything but http and https', async () => {
            for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'ftp://example.com/x', 'not a url']) {
                expect(await refused({ ...valid, url }), url).to.equal(true);
            }
        });

        it('one request per id at a time', async () => {
            let release = (): void => undefined;
            const fetcher = desktopFetcher({ fetch: () => new Promise<Response>(resolve => { release = () => resolve(new Response('ok')); }) });
            const first = fetcher.fetch(valid);
            const second = await fetcher.fetch(valid);
            expect(second).to.deep.equal({ ok: false, aborted: false, error: 'This request is already being sent.' });
            release();
            expect((await first).ok).to.equal(true);
        });
    });

    it('the request executor sends through it: the API\'s answer, with no browser in the way', async () => {
        const environment = { id: 'env-1', name: 'Local', baseUrl: base, authMethod: 'none' };
        const executor = new FetchRequestExecutor({
            environments: { getEnvironment: async () => environment, getActiveEnvironment: async () => environment },
            getToken: async () => undefined,
            logger,
            fetch: bridgeFetch(bridge())
        });
        const response = await executor.executeEndpoint({ id: 'e1', name: 'Get Carriers', method: 'GET', path: '/carriers', headers: {} } as unknown as APIEndpointConfig, undefined, 'env-1');
        expect(response.success).to.equal(true);
        expect(response.status).to.equal(200);
        expect((response.data as { carriers: string[] }).carriers).to.deep.equal(['DHL', 'UPS']);
    });
});
