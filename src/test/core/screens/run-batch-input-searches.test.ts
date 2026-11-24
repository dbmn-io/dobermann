// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Slice 5 (#470): Validate's ★ keeps the same saved searches as the Console's Input tab (it is the same tab, before
 * the run): `input.searches` beside the endpoint's Views, read and kept without touching a View.
 *   npm run test:core
 */
import { expect } from 'chai';
import { ConsoleViewsStore, VIEWS_REGISTRY_KEY } from '../../../services/console/console-views-store';
import { RunBatchController } from '../../../screens/run-batch/run-batch.controller';
import type { RunBatchPorts } from '../../../screens/run-batch/run-batch.ports';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { EnvironmentManager } from '../../../environmentManager';
import { ScreenSession } from '../../../screens/screen-session';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';

function memoryState() {
    const data = new Map<string, unknown>();
    return { get: <T>(key: string) => data.get(key) as T, update: async (key: string, value: unknown) => { data.set(key, value); }, data };
}

describe('Validate\'s saved searches are the Console Input tab\'s (slice 5)', () => {
    const endpoint = { id: 'ep-1', method: 'POST', path: '/stock', name: 'Stock' };
    const endpoints = {
        getEndpoint: async (id: string) => (id === endpoint.id ? endpoint as never : undefined),
        updateEndpoint: async () => undefined
    };

    it('a search saved on Validate is the Console Input tab\'s, and the Views stay as they were', async () => {
        const state = memoryState();
        const store = new ConsoleViewsStore({ state, endpoints });
        const views = { success: { activeView: 'Lines', views: [{ name: 'Lines' }] }, input: { activeView: '', views: [], searches: [{ name: 'Old', text: 'x' }] } };
        await store.save(endpoint.id, views);
        expect(await store.loadInputSearches(endpoint.id)).to.deep.equal([{ name: 'Old', text: 'x' }]);

        await store.saveInputSearches(endpoint.id, [{ name: 'Short', text: '@qty<0' }]);
        const all = await store.load(endpoint.id) as Record<string, { searches?: unknown; views?: unknown }>;
        expect(all.input.searches, 'what the Console reads as inputSearches').to.deep.equal([{ name: 'Short', text: '@qty<0' }]);
        expect(all.success, 'a data tab\'s Views untouched').to.deep.equal(views.success);
        expect(state.data.has(VIEWS_REGISTRY_KEY)).to.equal(true);
    });

    it('an endpoint with nothing kept: no searches; the first one saved makes the Input entry', async () => {
        const store = new ConsoleViewsStore({ state: memoryState(), endpoints });
        expect(await store.loadInputSearches(endpoint.id)).to.deep.equal([]);
        await store.saveInputSearches(endpoint.id, [{ name: 'Mine', text: 'woof' }]);
        expect(await store.loadInputSearches(endpoint.id)).to.deep.equal([{ name: 'Mine', text: 'woof' }]);
    });

    it('Run Batch reads and keeps them for its endpoint through the host (runBatch.inputSearches.*)', async () => {
        const context = memoryStoreContext();
        const manager = new APIEndpointManager(context);
        const ep = await manager.addEndpoint({ name: 'Stock', method: 'POST', path: '/stock', body: '{"sku":"{{sku}}"}' });
        const posted: Array<Record<string, unknown>> = [];
        const session = new ScreenSession({ post: m => posted.push(m as never) }, { openExternal: () => undefined });
        const state = memoryState();
        const ports = { endpoints: manager, environments: new EnvironmentManager(context), state, toast: { info() {}, warn() {}, error() {} } } as unknown as RunBatchPorts;
        const controller = new RunBatchController(session, ports, { context: 'runBatch', endpointId: ep.id, endpointName: ep.name, endpoint: ep } as never);
        await controller.handleMessage({ type: 'runBatch.inputSearches.save', searches: [{ name: 'Bad qty', text: '@qty<0' }, { name: 1 }] } as never);
        await controller.handleMessage({ type: 'runBatch.inputSearches.load' } as never);
        expect(posted.filter(m => m.type === 'runBatch.inputSearches').pop()).to.deep.equal({ type: 'runBatch.inputSearches', searches: [{ name: 'Bad qty', text: '@qty<0' }] });
        expect(await new ConsoleViewsStore({ state, endpoints: manager }).loadInputSearches(ep.id), 'the Console reads the same').to.deep.equal([{ name: 'Bad qty', text: '@qty<0' }]);
    });
});
