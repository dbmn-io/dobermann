// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #318: a scripted local HTTP server for `test:core`, so engine tests go through the
 * real global `fetch` instead of a stubbed function. Listens on 127.0.0.1, random port.
 */
import * as http from 'http';
import { AddressInfo } from 'net';

export interface RecordedRequest {
    method: string;
    /** Path plus query string, as the server received it. */
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

export interface StubResponse {
    status?: number;
    headers?: Record<string, string>;
    /** Objects are sent as JSON. */
    body?: string | object;
    delayMs?: number;
    /** Never respond: for timeout and cancel tests. The socket closes when the server stops. */
    hang?: boolean;
}

export type StubHandler = (request: RecordedRequest) => StubResponse;

export interface StubServer {
    /** Base URL with no trailing slash, e.g. `http://127.0.0.1:53121`. */
    url: string;
    /** Every request received, in arrival order. */
    requests: RecordedRequest[];
    /** Route by `"METHOD /path"` (query ignored). Unmatched requests get the fallback. */
    on(route: string, response: StubResponse | StubHandler): void;
    close(): Promise<void>;
}

const NOT_FOUND: StubResponse = { status: 404, body: { error: 'no stub route' } };

export async function startStubServer(fallback: StubResponse | StubHandler = NOT_FOUND): Promise<StubServer> {
    const routes = new Map<string, StubResponse | StubHandler>();
    const requests: RecordedRequest[] = [];

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const recorded: RecordedRequest = {
                method: req.method ?? 'GET',
                url: req.url ?? '/',
                headers: req.headers,
                body: Buffer.concat(chunks).toString('utf8')
            };
            requests.push(recorded);

            const path = recorded.url.split('?')[0];
            const route = routes.get(`${recorded.method} ${path}`) ?? fallback;
            const response = typeof route === 'function' ? route(recorded) : route;
            if (response.hang) {
                return;
            }

            const send = (): void => {
                const isJson = typeof response.body === 'object';
                const body = isJson ? JSON.stringify(response.body) : (response.body as string | undefined) ?? '';
                res.writeHead(response.status ?? 200, {
                    'content-type': isJson ? 'application/json' : 'text/plain',
                    ...response.headers
                });
                res.end(body);
            };
            if (response.delayMs) {
                setTimeout(send, response.delayMs);
            } else {
                send();
            }
        });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        on: (route, response) => { routes.set(route, response); },
        close: () => new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close(err => (err ? reject(err) : resolve()));
        })
    };
}
