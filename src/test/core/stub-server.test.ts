// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #318: the stub server behaves the way engine tests will rely on, through real `fetch`.
 */
import { expect } from 'chai';
import { startStubServer, StubServer } from './fixtures/stub-server';

describe('test:core stub HTTP server', () => {
    let server: StubServer;

    beforeEach(async () => {
        server = await startStubServer();
    });

    afterEach(async () => {
        await server.close();
    });

    it('answers a scripted route with JSON and records the request', async () => {
        server.on('POST /orders', { status: 201, body: { id: 'A1' } });

        const response = await fetch(`${server.url}/orders?dry=1`, {
            method: 'POST',
            headers: { authorization: 'Bearer t0k', 'content-type': 'application/json' },
            body: JSON.stringify({ sku: 'X' })
        });

        expect(response.status).to.equal(201);
        expect(await response.json()).to.deep.equal({ id: 'A1' });
        expect(server.requests).to.have.length(1);
        expect(server.requests[0]).to.include({ method: 'POST', url: '/orders?dry=1', body: '{"sku":"X"}' });
        expect(server.requests[0].headers.authorization).to.equal('Bearer t0k');
    });

    it('lets a handler vary the response per request', async () => {
        server.on('GET /items', req => (req.url.includes('fail') ? { status: 500, body: 'boom' } : { body: [] }));

        expect((await fetch(`${server.url}/items`)).status).to.equal(200);
        const failed = await fetch(`${server.url}/items?fail=1`);
        expect(failed.status).to.equal(500);
        expect(await failed.text()).to.equal('boom');
    });

    it('falls back to 404 for unscripted routes', async () => {
        expect((await fetch(`${server.url}/nope`)).status).to.equal(404);
    });

    it('can hang so a test can abort an in-flight request', async () => {
        server.on('GET /slow', { hang: true });
        const controller = new AbortController();

        const pending = fetch(`${server.url}/slow`, { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);

        let caught: unknown;
        try {
            await pending;
        } catch (error) {
            caught = error;
        }
        expect((caught as Error | undefined)?.name).to.equal('AbortError');
    });
});
