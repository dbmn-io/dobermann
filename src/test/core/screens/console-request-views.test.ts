// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Requests tab's Views (#468, host side): listed, saved, renamed, deleted; kept beside the data
 * tabs' Views of the endpoint without either ever wiping the other; carried by the endpoint's copy.
 * The real views store and endpoint manager, in memory.
 */
import { expect } from 'chai';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';
import { ConsoleViewsStore } from '../../../services/console/console-views-store';
import { RequestViews } from '../../../screens/console/requests/request-views';
import { ConsoleController } from '../../../screens/console/console.controller';
import { ScreenSession } from '../../../screens/screen-session';

type Message = Record<string, any>;
const DATA_TABS = {
    success: { activeView: 'Root', views: [{ name: 'Root', rowBasis: 'root', columns: [{ id: 'sku', source: 'current' }] }] },
    errors: { activeView: 'Root', views: [{ name: 'Root', rowBasis: 'root', columns: [{ id: 'reason', source: 'current' }] }] }
};

async function setup() {
    const context = memoryStoreContext();
    const endpoints = new APIEndpointManager(context);
    const endpoint = await endpoints.addEndpoint({ name: 'Put stock', method: 'POST', path: '/stock', body: '{"s":"{{s}}"}' });
    const store = new ConsoleViewsStore({ state: context.globalState, endpoints });
    let n = 0;
    const views = new RequestViews(store, () => `rv-${++n}`);
    return { context, endpoints, endpoint, store, views };
}

describe('Console Requests Views (#468)', () => {
    it('to start with: All columns only', async () => {
        const { views, endpoint } = await setup();
        expect(await views.list(endpoint.id)).to.deep.equal([{ id: 'all', name: 'All columns', columns: [], order: [], builtIn: true }]);
    });

    it('a new View is given an id and kept; its columns once each, hidden ones marked', async () => {
        const { views, endpoint } = await setup();
        const answer = await views.save(endpoint.id, {
            id: null, name: '  Errors   only ', order: ['n', 'status', 'response header: x-request-id', 'status'],
            columns: [{ id: 'n' }, { id: 'status' }, { id: 'request', hidden: true }, { id: 'status' }, { id: '' }, { id: 'response header: x-request-id' }]
        });
        expect(answer.id).to.equal('rv-1');
        expect(answer.views.map(v => v.name)).to.deep.equal(['All columns', 'Errors only']);
        expect(answer.views[1]).to.deep.equal({
            id: 'rv-1', name: 'Errors only', order: ['n', 'status', 'response header: x-request-id'],
            columns: [{ id: 'n' }, { id: 'status' }, { id: 'request', hidden: true }, { id: 'response header: x-request-id' }]
        });
        expect((await views.list(endpoint.id)).map(v => v.id)).to.deep.equal(['all', 'rv-1']);
    });

    it('saved again by its id: replaced, not added; renamed onto another\'s name: refused', async () => {
        const { views, endpoint } = await setup();
        await views.save(endpoint.id, { name: 'A', columns: [{ id: 'n' }], order: ['n'] });
        await views.save(endpoint.id, { name: 'B', columns: [{ id: 'n' }], order: ['n'] });
        const replaced = await views.save(endpoint.id, { id: 'rv-1', name: 'A wider', columns: [{ id: 'n' }, { id: 'http' }], order: ['n', 'http'] });
        expect(replaced.views.map(v => [v.id, v.name, v.order.length])).to.deep.equal([['all', 'All columns', 0], ['rv-1', 'A wider', 2], ['rv-2', 'B', 1]]);
        const clash = await views.save(endpoint.id, { id: 'rv-2', name: 'a WIDER', columns: [], order: [] });
        expect(clash.refused).to.equal('There is already a View called a WIDER.');
        expect(clash.views.map(v => v.name)).to.deep.equal(['All columns', 'A wider', 'B']);
    });

    it('All columns can\'t be saved over, taken as a name, or deleted; an empty name is refused', async () => {
        const { views, endpoint } = await setup();
        expect((await views.save(endpoint.id, { id: 'all', name: 'Mine', columns: [], order: [] })).refused).to.match(/save it under a new name/);
        expect((await views.save(endpoint.id, { name: 'all columns', columns: [], order: [] })).refused).to.match(/already a View/);
        expect((await views.save(endpoint.id, { name: '   ', columns: [], order: [] })).refused).to.equal('A View needs a name.');
        expect((await views.remove(endpoint.id, 'all')).refused).to.match(/always there/);
        expect((await views.list(endpoint.id)).map(v => v.id)).to.deep.equal(['all']);
    });

    it('deleted', async () => {
        const { views, endpoint } = await setup();
        await views.save(endpoint.id, { name: 'A', columns: [], order: [] });
        await views.save(endpoint.id, { name: 'B', columns: [], order: [] });
        expect((await views.remove(endpoint.id, 'rv-1')).views.map(v => v.name)).to.deep.equal(['All columns', 'B']);
    });

    it('beside the data tabs\' Views: a save of either never wipes the other', async () => {
        const { views, endpoint, store } = await setup();
        await store.save(endpoint.id, DATA_TABS);
        await views.save(endpoint.id, { name: 'Mine', columns: [{ id: 'n' }], order: ['n'] });
        expect(await store.load(endpoint.id), 'the data tabs see only theirs').to.deep.equal(DATA_TABS);
        await store.save(endpoint.id, { ...DATA_TABS, success: { ...DATA_TABS.success, activeView: 'Root' } });   // a data tab's save, as the page sends it
        expect((await views.list(endpoint.id)).map(v => v.name), 'still there').to.deep.equal(['All columns', 'Mine']);
    });

    it('a Requests View alone: the data tabs still see nothing saved (their defaults are made)', async () => {
        const { views, endpoint, store } = await setup();
        await views.save(endpoint.id, { name: 'Mine', columns: [], order: [] });
        expect(await store.load(endpoint.id)).to.equal(null);
    });

    it('the endpoint carries them, so an export takes them along', async () => {
        const { views, endpoint, store, endpoints } = await setup();
        await store.save(endpoint.id, DATA_TABS);
        await views.save(endpoint.id, { name: 'Mine', columns: [{ id: 'n' }], order: ['n'] });
        const copy = (await endpoints.getEndpoint(endpoint.id))!.consoleViews as unknown as { requests?: { views: Array<{ name: string }> } };
        expect(copy.requests?.views.map(v => v.name)).to.deep.equal(['Mine']);
    });

    it('through the controller: list, save, refuse with why', async () => {
        const { context, endpoints, endpoint } = await setup();
        const posted: Message[] = [];
        const toasts: string[] = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const controller = new ConsoleController(session, {
            metadata: {}, endpoints, state: context.globalState,
            logger: { log: () => undefined, error: () => undefined },
            toast: { info: () => undefined, warn: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m) }
        } as never, { type: 'batch', batchId: 'b-1', endpointId: endpoint.id, responseFiles: [] } as never);
        await controller.handle({ type: 'console.views.list', tab: 'requests' });
        await controller.handle({ type: 'console.views.save', tab: 'requests', view: { id: null, name: 'Mine', columns: [{ id: 'n' }], order: ['n'] } });
        await controller.handle({ type: 'console.views.save', tab: 'requests', view: { id: null, name: 'mine', columns: [], order: [] } });
        await controller.handle({ type: 'console.views.list', tab: 'success' });
        const said = posted.filter(m => m.type === 'console.views');
        expect(said[0]).to.deep.include({ tab: 'requests' });
        expect(said[0].views.map((v: Message) => v.name)).to.deep.equal(['All columns']);
        expect(said[1].id).to.be.a('string');
        expect(said[1].views.map((v: Message) => v.name)).to.deep.equal(['All columns', 'Mine']);
        expect(said[2].refused).to.equal('There is already a View called mine.');
        expect(toasts).to.deep.equal(['There is already a View called mine.']);
        expect(said[3]).to.deep.include({ tab: 'success', views: [] });
        expect(said[3].error).to.be.a('string');
        controller.dispose();
    });
});
