// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #322: FetchRequestExecutor sends real requests (to the stub server) with no VS Code.
 * Host parts — environments, tokens, JWT header checks, mocks — are plain functions here.
 */
import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import { FetchRequestExecutor } from '../../../services/execution/fetch-request-executor';
import { EndpointResponse, RequestEnvironment } from '../../../services/execution/request-executor.interface';
import { startStubServer, StubServer } from '../fixtures/stub-server';
import { createMockLogger } from '../../helpers/logging/mock-logger';

function endpoint(fields: Partial<APIEndpointConfig>): APIEndpointConfig {
    return { id: 'ep-1', name: 'Orders', path: '/orders', method: 'GET', headers: {}, queryParams: {}, ...fields } as APIEndpointConfig;
}

describe('FetchRequestExecutor (Issue #322)', () => {
    let server: StubServer;
    let environment: RequestEnvironment | undefined;
    let getToken: SinonStub;
    let executor: FetchRequestExecutor;

    beforeEach(async () => {
        server = await startStubServer();
        environment = { id: 'env-1', name: 'Local', baseUrl: server.url, authMethod: 'jwt' };
        getToken = stub().resolves('t0k');
        executor = new FetchRequestExecutor({
            environments: {
                getEnvironment: async (id: string) => (environment?.id === id ? environment : undefined),
                getActiveEnvironment: async () => environment
            },
            getToken,
            logger: createMockLogger()
        });
    });

    afterEach(async () => {
        await server.close();
    });

    it('#424: a variable in the base URL\'s path is filled from the environment; a batch member\'s fixed URL wins', async () => {
        server.on('GET /v2.0/acme/orders', { body: [] });
        server.on('GET /v1.0/fixed/orders', { body: [] });
        environment = { id: 'env-1', name: 'Local', baseUrl: `${server.url}/v2.0/{{ENV:tenant}}`, authMethod: 'jwt', variables: { tenant: 'acme' } };

        const live = await executor.executeEndpoint(endpoint({}), undefined, 'env-1');
        expect(live).to.include({ status: 200, url: `${server.url}/v2.0/acme/orders` });

        const fixed = await executor.executeEndpoint(endpoint({}), undefined, 'env-1', { isBatchMember: true, baseUrl: `${server.url}/v1.0/fixed` });
        expect(fixed).to.include({ status: 200 });
        expect(server.requests.map(r => r.url)).to.deep.equal(['/v2.0/acme/orders', '/v1.0/fixed/orders']);
    });

    it('GET: a path with its own query keeps it as typed, and query params join it with &', async () => {
        server.on('GET /orders', { body: [] });

        await executor.executeEndpoint(endpoint({ path: '/orders?status=open' }), undefined, 'env-1');
        await executor.executeEndpoint(endpoint({ path: '/orders?status=open', queryParams: { page: { value: '2', enabled: true } } }), undefined, 'env-1');
        await executor.executeEndpoint(endpoint({ queryParams: { page: { value: '2', enabled: false } } }), undefined, 'env-1');
        expect(server.requests.map(r => r.url)).to.deep.equal(['/orders?status=open', '/orders?status=open&page=2', '/orders']);
    });

    it('GET: enabled query params on the URL, bearer token and headers sent, JSON parsed', async () => {
        server.on('GET /orders', { body: [{ id: 1 }] });

        const result = await executor.executeEndpoint(endpoint({
            headers: { Organization: { value: 'ORG1', enabled: true }, 'X-Off': { value: 'no', enabled: false } },
            queryParams: { status: { value: 'open', enabled: true }, page: { value: '2', enabled: true }, skip: { value: 'x', enabled: false } }
        }), undefined, 'env-1');

        expect(result).to.include({ success: true, status: 200, url: `${server.url}/orders?status=open&page=2` });
        expect(result.data).to.deep.equal([{ id: 1 }]);
        const sent = server.requests[0];
        expect(sent.url).to.equal('/orders?status=open&page=2');
        expect(sent.headers.authorization).to.equal('Bearer t0k');
        expect(sent.headers.organization).to.equal('ORG1');
        expect(sent.headers['x-off']).to.equal(undefined);
        expect(getToken.calledOnceWith(environment, 'env-1')).to.equal(true);
    });

    it('POST: a JSONC body is sent as plain JSON; a text response comes back as text', async () => {
        server.on('POST /orders', { status: 201, body: 'created' });

        const result = await executor.executeEndpoint(endpoint({
            method: 'POST',
            body: '{\n  // one order\n  "sku": "A"\n}'
        }), undefined, 'env-1');

        expect(result).to.include({ success: true, status: 201, data: 'created' });
        expect(server.requests[0].body).to.equal('{"sku":"A"}');
        expect(server.requests[0].headers['content-type']).to.equal('application/json');
    });

    it('POST: its enabled query parameters are sent too (they were dropped: only GET sent them)', async () => {
        server.on('POST /orders', { status: 200, body: { ok: true } });
        await executor.executeEndpoint(endpoint({
            method: 'POST', body: '{ "sku": "A" }',
            queryParams: { page: { value: '0', enabled: true }, size: { value: '100', enabled: true }, skip: { value: 'x', enabled: false } }
        }), undefined, 'env-1');
        expect(server.requests[0].url).to.equal('/orders?page=0&size=100');
        expect(server.requests[0].body).to.equal('{"sku":"A"}');
    });

    it('JSONL (#115): the lines come back as records, with the format', async () => {
        server.on('GET /orders', { headers: { 'content-type': 'application/x-ndjson' }, body: '{"id":1}\n{"id":2}\n' });
        const result = await executor.executeEndpoint(endpoint({}), undefined, 'env-1');
        expect(result).to.include({ success: true, status: 200 });
        expect(result.data).to.deep.equal([{ id: 1 }, { id: 2 }]);
        expect(result.format).to.deep.equal({ kind: 'jsonl', records: 2, invalid: [], invalidCount: 0 });
    });

    it('JSONL progress (#115): bytes and lines as they arrive, X-Total-Count as the total, done at the end', async () => {
        server.on('GET /orders', { headers: { 'content-type': 'application/x-ndjson', 'x-total-count': '2' }, body: '{"id":1}\n{"id":2}\n' });
        const heard: Array<Record<string, unknown>> = [];
        await executor.executeEndpoint(endpoint({}), undefined, 'env-1', { onBodyProgress: p => heard.push({ ...p }) });
        expect(heard[heard.length - 1]).to.deep.include({ bytes: 18, lines: 2, totalRecords: 2, jsonl: true, done: true });
    });

    it('a JSON content type with a body that is not JSON keeps the body (#115)', async () => {
        server.on('GET /orders', { status: 502, headers: { 'content-type': 'application/json' }, body: 'Bad Gateway' });
        const result = await executor.executeEndpoint(endpoint({}), undefined, 'env-1');
        expect(result).to.include({ success: true, status: 502, data: 'Bad Gateway' });
        expect(result.format).to.equal(undefined);
    });

    it('an HTTP error is still a response: success, with its status and body', async () => {
        server.on('GET /orders', { status: 500, body: { error: 'boom' } });
        const result = await executor.executeEndpoint(endpoint({}), undefined, 'env-1');
        expect(result).to.include({ success: true, status: 500 });
        expect(result.data).to.deep.equal({ error: 'boom' });
    });

    it('nothing listening: a network error result, not a throw', async () => {
        const deadUrl = server.url;
        await server.close();
        server = await startStubServer();
        environment = { id: 'env-1', name: 'Local', baseUrl: deadUrl, authMethod: 'jwt' };

        const result: EndpointResponse = await executor.executeEndpoint(endpoint({}), undefined, 'env-1');

        expect(result.success).to.equal(false);
        expect(result.statusText).to.match(/^Network error: /);
        expect(result.url).to.equal(`${deadUrl}/orders`);
    });

    it("authMethod 'none': no Authorization header", async () => {
        environment = { ...environment!, authMethod: 'none' };
        getToken.resolves(undefined);
        server.on('GET /orders', { body: [] });

        await executor.executeEndpoint(endpoint({}), undefined, 'env-1');

        expect(server.requests[0].headers.authorization).to.equal(undefined);
    });

    it('no token: an interactive run refuses; a batch member sends without one (the engine handles the 401)', async () => {
        getToken.resolves(undefined);
        server.on('GET /orders', { status: 401, body: { error: 'unauthorized' } });

        let refused: unknown;
        try {
            await executor.executeEndpoint(endpoint({}), undefined, 'env-1');
        } catch (error) {
            refused = error;
        }
        expect((refused as Error).message).to.equal('No authentication token available. Please authenticate first.');
        expect(server.requests).to.have.length(0);

        const result = await executor.executeEndpoint(endpoint({}), undefined, 'env-1', { isBatchMember: true });
        expect(result.status).to.equal(401);
        expect(server.requests[0].headers.authorization).to.equal(undefined);
    });

    it('an unknown environment id stops the run; it never falls back to the active one (Issue #160)', async () => {
        let stopped: unknown;
        try {
            await executor.executeEndpoint(endpoint({}), undefined, 'env-gone');
        } catch (error) {
            stopped = error;
        }
        expect((stopped as Error).message).to.equal("CRITICAL: Environment 'env-gone' not found. Execution STOPPED.");
        expect(server.requests).to.have.length(0);
    });

    it('no base URL: refused', async () => {
        environment = { ...environment!, baseUrl: undefined };
        let refused: unknown;
        try {
            await executor.executeEndpoint(endpoint({}), undefined, 'env-1');
        } catch (error) {
            refused = error;
        }
        expect((refused as Error).message).to.match(/^No base URL configured/);
    });
});
