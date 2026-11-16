// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as sinon from 'sinon';
import { GlobalSystemsService, globalSystemFromRow } from '../../../services/systems/global-systems.service';
import { SystemManager } from '../../../systemManager';
import { dbmnStorageKeys } from '../../../services/dbmn-backend/backend-config';
import type { StoreContext } from '../../../platform/interfaces/store-context.interface';

/**
 * #415: one System concept, two kinds. A user's own System lives in their catalogue; a global
 * System is configured by DBMN in Supabase and listed for every signed-in user. The app
 * fetches and caches the global ones (signed in once, kept offline), and never changes them.
 */
describe('#415 Global Systems', () => {
    let stored: Record<string, unknown>;
    const store = {
        get: <T>(key: string) => stored[key] as T,
        update: (key: string, value: unknown) => { stored[key] = value; return Promise.resolve(); }
    };
    let auth: { isAuthenticated(): boolean; ensureValidSession(): Promise<{ status: string }>; getSession(): { accessToken: string } | null };
    let fetchStub: sinon.SinonStub;
    // Put Node's own fetch back afterwards: later core tests send real requests with it
    const originalFetch = global.fetch;

    const row = (id: string, item: Record<string, unknown> = {}) => ({ id, item: { id, name: id, ...item } });
    const ok = (rows: unknown) => ({ ok: true, status: 200, json: async () => rows });

    beforeEach(() => {
        stored = {};
        auth = {
            isAuthenticated: () => true,
            ensureValidSession: async () => ({ status: 'success' }),
            getSession: () => ({ accessToken: 'token-abc' })
        };
        fetchStub = sinon.stub();
        (global as unknown as { fetch: unknown }).fetch = fetchStub;
    });

    afterEach(() => {
        sinon.restore();
        global.fetch = originalFetch;
    });

    describe('GlobalSystemsService', () => {
        it('fetches the active global Systems with the user\'s token, and lists them as global', async () => {
            fetchStub.resolves(ok([row('samplewms', { description: 'Made up', config: { oauth: {} } })]));
            const service = new GlobalSystemsService(store, auth, () => 'http://127.0.0.1:54321', () => 'anon');
            await service.refresh();

            const [url, init] = fetchStub.firstCall.args;
            expect(url).to.equal('http://127.0.0.1:54321/rest/v1/global_systems?select=id,item');
            expect(init.headers).to.deep.equal({ Authorization: 'Bearer token-abc', apikey: 'anon' });
            const [system] = service.getAll();
            expect(system).to.include({ id: 'samplewms', name: 'samplewms', scope: 'global', description: 'Made up' });
            expect(system.config).to.deep.equal({ oauth: {} });
        });

        it('keeps them for next time: a new start lists them before any fetch (signed in once)', async () => {
            fetchStub.resolves(ok([row('samplewms')]));
            await new GlobalSystemsService(store, auth).refresh();

            const offline = new GlobalSystemsService(store, auth);
            expect(offline.getAll().map(s => s.id)).to.deep.equal(['samplewms']);
            expect(stored[dbmnStorageKeys().globalSystems]).to.be.an('array').with.length(1);
        });

        it('keeps the cached list when signed out, offline, or the server fails', async () => {
            fetchStub.resolves(ok([row('samplewms')]));
            const service = new GlobalSystemsService(store, auth);
            await service.refresh();

            auth.ensureValidSession = async () => ({ status: 'signed_out' });
            await service.refresh();
            auth.ensureValidSession = async () => ({ status: 'success' });
            fetchStub.rejects(new Error('offline'));
            await service.refresh();
            fetchStub.resolves({ ok: false, status: 500, json: async () => ({}) });
            await service.refresh();
            fetchStub.resolves(ok({ not: 'a list' }));
            await service.refresh();

            expect(service.getAll().map(s => s.id)).to.deep.equal(['samplewms']);
        });

        it('a successful fetch replaces the list: a System DBMN withdraws leaves, and listeners hear of it', async () => {
            fetchStub.resolves(ok([row('samplewms'), row('other')]));
            const service = new GlobalSystemsService(store, auth);
            await service.refresh();
            const changed = sinon.spy();
            service.onChanged(changed);

            fetchStub.resolves(ok([row('samplewms')]));
            await service.refresh();
            expect(service.getAll().map(s => s.id)).to.deep.equal(['samplewms']);
            expect(changed.calledOnce).to.equal(true);

            await service.refresh();
            expect(changed.calledOnce, 'nothing changed: nobody told').to.equal(true);
        });

        it('skips a row that is not a valid System, and keeps the rest', async () => {
            fetchStub.resolves(ok([row('samplewms'), { id: 'bad', item: { name: '' } }, { id: 'nope' }]));
            const service = new GlobalSystemsService(store, auth);
            await service.refresh();
            expect(service.getAll().map(s => s.id)).to.deep.equal(['samplewms']);
        });

        it('a row is global whatever its item says, and its id is the row\'s', () => {
            const system = globalSystemFromRow({ id: 'samplewms', item: { id: 'other', name: 'samplewms', scope: 'user' } });
            expect(system).to.include({ id: 'samplewms', scope: 'global' });
        });
    });

    describe('SystemManager: one list, the global Systems with the user\'s own', () => {
        let systems: SystemManager;
        let global: GlobalSystemsService;

        beforeEach(async () => {
            const state: Record<string, unknown> = {};
            const context = {
                globalState: {
                    get: <T>(key: string) => state[key] as T,
                    update: (key: string, value: unknown) => { state[key] = value; return Promise.resolve(); },
                    keys: () => Object.keys(state)
                }
            } as unknown as StoreContext;
            systems = new SystemManager(context);
            await systems.addSystem({ name: 'mine' });
            fetchStub.resolves(ok([row('samplewms')]));
            global = new GlobalSystemsService(store, auth);
            await global.refresh();
            systems.setGlobalSystems(global);
        });

        it('lists the user\'s own first, then the global ones', async () => {
            const all = await systems.getAllSystems();
            expect(all.map(s => s.name)).to.deep.equal(['mine', 'samplewms']);
            expect(await systems.getSystem('samplewms')).to.include({ scope: 'global' });
        });

        it('never saves a global System into the user\'s store', async () => {
            await systems.addSystem({ name: 'another' });
            const own = await (systems as unknown as { getOwnSystems(): Promise<Array<{ name: string }>> }).getOwnSystems();
            expect(own.map(s => s.name)).to.deep.equal(['mine', 'another']);
        });

        it('a global System can\'t be renamed or deleted in the app', async () => {
            let error: Error | undefined;
            try { await systems.updateSystem('samplewms', { name: 'renamed' }); } catch (e) { error = e as Error; }
            expect(error?.message).to.match(/global System, maintained by DBMN/);
            error = undefined;
            try { await systems.deleteSystem('samplewms'); } catch (e) { error = e as Error; }
            expect(error?.message).to.match(/global System, maintained by DBMN/);
        });

        it('a new System can\'t take a global System\'s name, and is always the user\'s own', async () => {
            let error: Error | undefined;
            try { await systems.addSystem({ name: 'samplewms' }); } catch (e) { error = e as Error; }
            expect(error?.message).to.match(/already exists/);
            const added = await systems.addSystem({ name: 'third', scope: 'global' });
            expect(added.scope).to.equal(undefined);
        });

        it('tells listeners when the global Systems change', async () => {
            const changed = sinon.spy();
            systems.onSystemsChanged(changed);
            fetchStub.resolves(ok([row('samplewms'), row('other')]));
            await global.refresh();
            expect(changed.called).to.equal(true);
            expect((await systems.getAllSystems()).map(s => s.name)).to.deep.equal(['mine', 'other', 'samplewms']);
        });
    });
});
