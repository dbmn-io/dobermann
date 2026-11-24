// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A paginated POST whose page and size are asked for twice: as query parameters and in the JSON
 * body, each a {{A8:PAGE…}} / {{A8:SIZE…}} (an API that reads one or the other). It wouldn't run,
 * and what it said was hard to read. Real pipeline, real fetch, a stub server that records what it
 * was sent. Made-up endpoint: an item search.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import type { RequestEnvironment } from '../../../services/execution/request-executor.interface';
import { PaginationDetectorService } from '../../../services/pagination/pagination-detector.service';
import { buildCorePipeline, CorePipeline } from '../fixtures/core-pipeline';
import { startStubServer, StubServer } from '../fixtures/stub-server';

const SEARCH: APIEndpointConfig = {
    id: 'endpoint-item-search', name: 'Item search', method: 'POST', path: '/items/search', headers: {},
    queryParams: { Page: { value: '{{A8:PAGE:0:header.totalCount}}', enabled: true }, Size: { value: '{{A8:SIZE:100:header.size}}', enabled: true } },
    body: [
        '{',
        '  // "Query": "Volume > 0",',
        '  "Size": "{{A8:SIZE:100:header.size}}",',
        '  "Page": "{{A8:PAGE:0:header.page}}",',
        '  "Template": { "ItemId": null, "UnitPrice": null }',
        '}'
    ].join('\n')
} as unknown as APIEndpointConfig;

describe('A paginated POST with its page and size in the query and the body', () => {
    let tempDir: string;
    let server: StubServer;
    let environment: RequestEnvironment;
    let pipeline: CorePipeline;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-paged-post-'));
        server = await startStubServer();
        environment = { id: 'env-stub', name: 'Stub API', baseUrl: server.url, authMethod: 'none' };
        pipeline = await buildCorePipeline(tempDir, environment);
    });

    afterEach(async () => {
        pipeline?.close();
        await server.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it('runs: the first page asked for in both places, with the same page and size', async () => {
        server.on('POST /items/search', { status: 200, body: { header: { totalCount: 250, size: 100, page: 0 }, data: [{ ItemId: 'A-1', UnitPrice: 1 }] } });
        const paginationConfig = new PaginationDetectorService().detectPagination(SEARCH);
        expect(paginationConfig.enabled, 'detected as paginated').to.equal(true);
        const prepared = await pipeline.preparation.preparePaginatedBatch({
            endpoint: SEARCH, environment: environment.name, environmentId: environment.id,
            workspaceRoot: pipeline.workspaceRoot, paginationConfig
        } as never);
        const state = await pipeline.engine.executeRecord(prepared.batchId!);
        const sent = server.requests.find(r => r.method === 'POST');
        expect(sent, `a request was sent (${JSON.stringify(state)})`).to.not.equal(undefined);
        const query = new URL(sent!.url, server.url).searchParams;
        expect([query.get('Page'), query.get('Size')], 'the query').to.deep.equal(['0', '100']);
        const body = JSON.parse(sent!.body as string);
        expect([body.Page, body.Size], 'the body').to.deep.equal(['0', '100']);
        expect(body.Template).to.deep.equal({ ItemId: null, UnitPrice: null });
    });

    it('a later page (Next Page, Fetch All): the page and the size the API sends, in both places', () => {
        const page = new PaginationDetectorService().endpointForPage(SEARCH, 3, 50);
        expect(page.queryParams).to.deep.equal({ Page: { value: '3', enabled: true }, Size: { value: '50', enabled: true } });
        expect(page.body).to.include('"Size": "50"').and.include('"Page": "3"');
        expect(page.body).to.not.include('A8:');
        expect(SEARCH.body, 'the endpoint itself is left as it was').to.include('{{A8:PAGE:0:header.page}}');
    });
});
