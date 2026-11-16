// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import type { SystemConfig } from '../../../data-loading/system-schema';
import { SystemManager } from '../../../systemManager';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { EnvironmentManager } from '../../../environmentManager';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';
import { globalSystemForUrl, suggestEnvironmentName } from '../../../services/systems/system-match';
import { environmentsToLink, linkEnvironmentsToGlobalSystems, switchToGlobalSystems, wireGlobalSystemSwitch } from '../../../services/systems/global-system-adoption';
import { SystemOperationsService } from '../../../services/systems/system-operations.service';
import { planImportedSystems } from '../../../services/import-export/system-refs';
import {
    ADD_NEW_SYSTEM, ExistingEnvironmentChoice, KnownEnvironment, NewEnvironmentDraft, STANDARD_SYSTEMS_NOT_LOADED,
    STANDARD_SYSTEMS, YOUR_SYSTEMS, promptNewEnvironmentInModal, systemOptions
} from '../../../screens/new-environment-prompt';
import type { DbmnModalResult, DbmnModalSpec } from '../../../screens/modal.types';

/**
 * #415 phase 2: a new environment asks for its System first, then its URL. Standard (global)
 * Systems are listed first, a URL that belongs to one picks it, and a user's own System named
 * like one is switched to it without asking.
 */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const sample: SystemConfig = {
    id: 'samplewms', name: 'samplewms', scope: 'global', createdAt: 0,
    config: { match: '^(?<instance>[a-z0-9-]+)\\.samplewms\\.test$' }
};
const other: SystemConfig = { id: 'otherwms', name: 'otherwms', scope: 'global', createdAt: 0, config: { match: '\\.other\\.test$' } };
const own = (id: string, name: string, fields: Partial<SystemConfig> = {}): SystemConfig => ({ id, name, createdAt: 1, ...fields });

/** Global Systems as GlobalSystemsService hands them over, changeable by the test. */
function globalSource(systems: SystemConfig[]) {
    let listeners: Array<() => void> = [];
    return {
        systems,
        getAll: () => [...systems],
        onChanged: (listener: () => void) => { listeners.push(listener); return { dispose: () => { listeners = listeners.filter(l => l !== listener); } }; },
        set(next: SystemConfig[]) { systems = next; listeners.forEach(l => l()); }
    };
}

/** A ModalHost that answers each dialog in turn, running a submit handler as the screen does. */
function scriptedHost(answers: Array<(spec: DbmnModalSpec) => DbmnModalResult>) {
    const shown: DbmnModalSpec[] = [];
    const errors: Array<Record<string, string> | undefined> = [];
    return {
        shown, errors,
        async showModal(spec: DbmnModalSpec): Promise<DbmnModalResult> {
            shown.push(spec);
            const answer = answers.shift();
            if (!answer) throw new Error(`no answer scripted for "${spec.title}"`);
            const result = answer(spec);
            const submit = spec.actions.find(a => a.id === result.actionId)?.onSubmit;
            if (submit) {
                try {
                    await submit(result.fields);
                } catch (error) {
                    errors.push((error as { fieldErrors?: Record<string, string> }).fieldErrors);
                    return { actionId: 'dismiss', fields: {} };
                }
            }
            return result;
        }
    };
}
const choose = (actionId: string, fields: Record<string, string> = {}) => () => ({ actionId, fields });

/** The dialog when no environment has the URL: it answers with a new environment's draft. */
const newDraft = (...args: Parameters<typeof promptNewEnvironmentInModal>) =>
    promptNewEnvironmentInModal(...args) as Promise<NewEnvironmentDraft | undefined>;

function systemsWith(list: SystemConfig[]) {
    const all = [...list];
    return {
        all,
        getAllSystems: async () => [...all],
        addSystem: async ({ name }: { name: string }) => {
            const created = own(`system_${all.length}`, name);
            all.push(created);
            return created;
        }
    };
}

describe('#415 A new environment: its System first, then its URL', () => {
    describe('which Standard System a URL belongs to', () => {
        it('matches a global System\'s pattern against the URL\'s host, case aside', () => {
            const systems = [own('system_1', 'mine', { config: { match: '.*' } }), sample, other];
            expect(globalSystemForUrl('https://ACME-dev.samplewms.test/api/v1', systems)?.id).to.equal('samplewms');
            expect(globalSystemForUrl('https://x.other.test', systems)?.id).to.equal('otherwms');
            expect(globalSystemForUrl('https://acme.example.com', systems), 'an own System never matches').to.equal(undefined);
            expect(globalSystemForUrl('ftp://acme.samplewms.test', systems)).to.equal(undefined);
            expect(globalSystemForUrl('not a url', systems)).to.equal(undefined);
        });

        it('a pattern that isn\'t valid is ignored, never an error', () => {
            const broken: SystemConfig = { ...sample, id: 'broken', config: { match: '([' } };
            expect(globalSystemForUrl('https://acme.samplewms.test', [broken, sample])?.id).to.equal('samplewms');
        });

        it('names the environment System: the URL\'s first label, or the host and port for an address or localhost', () => {
            expect(suggestEnvironmentName('https://acme-dev.samplewms.test/x', 'samplewms')).to.equal('samplewms: acme-dev');
            expect(suggestEnvironmentName('http://127.0.0.1:54321/functions/v1/playground', 'dbmn')).to.equal('dbmn: 127.0.0.1:54321');
            expect(suggestEnvironmentName('http://localhost:3000', 'erp')).to.equal('erp: localhost:3000');
            expect(suggestEnvironmentName('https://acme.example.com', '')).to.equal('acme');
            expect(suggestEnvironmentName('nope', 'dbmn')).to.equal('');
        });
    });

    describe('the New environment dialog', () => {
        it('lists the Standard Systems first, then the user\'s own, then Add', () => {
            const options = systemOptions([own('system_2', 'zeta'), sample, own('system_1', 'alpha'), other]);
            expect(options.map(o => [o.label, o.group])).to.deep.equal([
                ['-- Select System --', undefined],
                ['otherwms', STANDARD_SYSTEMS],
                ['samplewms', STANDARD_SYSTEMS],
                ['alpha', YOUR_SYSTEMS],
                ['zeta', YOUR_SYSTEMS],
                ['+ Add new System…', undefined]
            ]);
            // With no Standard Systems, no headings
            expect(systemOptions([own('system_1', 'alpha')]).every(o => !o.group)).to.equal(true);
        });

        it('asks for the System, then the URL, and opens the editor with both and a name', async () => {
            const host = scriptedHost([choose('continue', { system: 'system_1', baseUrl: ' https://acme.example.com/api ' })]);
            const draft = await newDraft(systemsWith([own('system_1', 'mine')]), host, {});
            expect(host.shown[0].fields!.map(f => f.id)).to.deep.equal(['system', 'baseUrl']);
            expect(draft).to.deep.equal({ systemId: 'system_1', baseUrl: 'https://acme.example.com/api', name: 'mine: acme' } satisfies NewEnvironmentDraft);
        });

        it('with no System chosen, a URL that belongs to a Standard System picks it', async () => {
            const host = scriptedHost([choose('continue', { system: '', baseUrl: 'https://acme.samplewms.test' })]);
            const draft = await newDraft(systemsWith([own('system_1', 'mine'), sample]), host, {});
            expect(draft?.systemId).to.equal('samplewms');
            expect(host.shown, 'no question: nothing was chosen').to.have.length(1);
        });

        it('keeps the dialog open, saying what\'s missing: a System, or a URL it can use', async () => {
            const host = scriptedHost([
                choose('continue', { system: '', baseUrl: 'https://acme.example.com' }),
            ]);
            expect(await newDraft(systemsWith([sample]), host, {})).to.equal(undefined);
            expect(host.errors[0]).to.have.property('system');

            const badUrl = scriptedHost([choose('continue', { system: 'samplewms', baseUrl: 'acme.samplewms.test' })]);
            await newDraft(systemsWith([sample]), badUrl, {});
            expect(badUrl.errors[0]).to.have.property('baseUrl');
        });

        it('a URL that belongs to a different Standard System asks which to use: nothing switches unseen', async () => {
            const systems = systemsWith([own('system_1', 'mine'), sample, other]);
            const url = { baseUrl: 'https://acme.samplewms.test' };

            const use = scriptedHost([choose('continue', { system: 'system_1', ...url }), choose('use')]);
            expect((await newDraft(systems, use, {}))?.systemId).to.equal('samplewms');
            expect(use.shown[1].title).to.equal('Use samplewms?');
            expect(use.shown[1].actions.map(a => a.label)).to.deep.equal(['Keep "mine"', 'Use samplewms']);

            const keep = scriptedHost([choose('continue', { system: 'otherwms', ...url }), choose('keep')]);
            expect((await newDraft(systems, keep, {}))?.systemId).to.equal('otherwms');

            const away = scriptedHost([choose('continue', { system: 'system_1', ...url }), choose('dismiss')]);
            expect(await newDraft(systems, away, {})).to.equal(undefined);

            // The one chosen is the one the URL belongs to: no question
            const same = scriptedHost([choose('continue', { system: 'samplewms', ...url })]);
            expect((await newDraft(systems, same, {}))?.systemId).to.equal('samplewms');
        });

        it('+ Add new System… names a new one, and the environment opens on it', async () => {
            const systems = systemsWith([sample]);
            const host = scriptedHost([
                choose('continue', { system: ADD_NEW_SYSTEM, baseUrl: 'https://acme.example.com' }),
                choose('create', { name: 'erp' })
            ]);
            const draft = await newDraft(systems, host, {});
            expect(host.shown[1].title).to.equal('New System');
            expect(systems.all.map(s => s.name)).to.include('erp');
            expect(draft?.systemId).to.equal(systems.all.find(s => s.name === 'erp')!.id);
            expect(draft?.name).to.equal('erp: acme');
        });

        it('with no Standard Systems loaded yet, it says they arrive from DBMN when online (#418: no sign-in needed)', async () => {
            const out = scriptedHost([choose('cancel')]);
            await newDraft(systemsWith([own('system_1', 'mine')]), out, {});
            expect(out.shown[0].body).to.include(STANDARD_SYSTEMS_NOT_LOADED);

            // Loaded (they are kept offline): nothing to say
            const kept = scriptedHost([choose('cancel')]);
            await newDraft(systemsWith([sample]), kept, {});
            expect(kept.shown[0].body).not.to.include(STANDARD_SYSTEMS_NOT_LOADED);
        });
    });

    describe('a URL an environment already has: a warning, never a block', () => {
        const acme: KnownEnvironment = { id: 'env-1', name: 'acme-dev', baseUrl: 'https://acme-dev.samplewms.test/', systemId: 'samplewms' };
        const ask = (answers: Array<(spec: DbmnModalSpec) => DbmnModalResult>, environments: KnownEnvironment[], systemId = 'samplewms', systems = systemsWith([sample, own('system_1', 'erp')])) => {
            const host = scriptedHost([choose('continue', { system: systemId, baseUrl: 'HTTPS://acme-dev.samplewms.test' }), ...answers]);
            return { host, result: promptNewEnvironmentInModal(systems, host, { environments }) };
        };

        it('the same URL, case and a trailing slash aside, on the same System: open it, or add another', async () => {
            const { host, result } = ask([choose('open')], [acme, { id: 'env-2', name: 'other', baseUrl: 'https://acme-dev.samplewms.test/api' }]);
            expect(await result).to.deep.equal({ openEnvironmentId: 'env-1' } satisfies ExistingEnvironmentChoice);
            expect(host.shown[1].body).to.equal('You already have "acme-dev" for this URL. Open it, or add a new one for this URL.');
            expect(host.shown[1].actions.map(a => a.label)).to.deep.equal(['New', 'Open']);

            const another = ask([choose('add')], [acme]);
            expect(await another.result).to.deep.equal({ systemId: 'samplewms', baseUrl: 'HTTPS://acme-dev.samplewms.test', name: 'samplewms: acme-dev' });
            expect(await ask([choose('dismiss')], [acme]).result).to.equal(undefined);
        });

        it('on a different System: says so, and can move it to the one chosen', async () => {
            const onErp = { ...acme, systemId: 'system_1' };
            const { host, result } = ask([choose('move')], [onErp]);
            expect(await result).to.deep.equal({ openEnvironmentId: 'env-1', moveToSystemId: 'samplewms' });
            expect(host.shown[1].body).to.equal('"acme-dev" already uses this URL, under erp. You chose samplewms. Move it to samplewms, open it as it is, or add a new one for this URL.');
            expect(host.shown[1].actions.map(a => a.label)).to.deep.equal(['New', 'Move', 'Open']);

            expect(await ask([choose('open')], [onErp]).result, 'opened as it is').to.deep.equal({ openEnvironmentId: 'env-1' });
        });

        it('moved to a new System: named first, then moved', async () => {
            // No Standard System here, so the URL doesn't ask about one first
            const systems = systemsWith([own('system_1', 'erp')]);
            const { result } = ask([choose('move'), choose('create', { name: 'wms2' })], [acme], ADD_NEW_SYSTEM, systems);
            const choice = await result;
            expect(choice).to.deep.equal({ openEnvironmentId: 'env-1', moveToSystemId: systems.all.find(s => s.name === 'wms2')?.id });
        });

        it('several with the URL: pick which one', async () => {
            const admin = { ...acme, id: 'env-2', name: 'acme-admin', systemId: 'system_1' };
            const { host, result } = ask([choose('open', { environment: 'env-2' })], [acme, admin]);
            expect(await result).to.deep.equal({ openEnvironmentId: 'env-2' });
            expect(host.shown[1].body).to.equal('You already have 2 environments for this URL. You chose samplewms. Pick one to move or open, or add a new one for this URL.');
            expect(host.shown[1].fields![0].options!.map(o => `${o.label} (${o.description})`)).to.deep.equal(['acme-dev (samplewms)', 'acme-admin (erp)']);
        });
    });

    describe('a user\'s own settings on a Standard System', () => {
        it('are kept as the user\'s own, listed on the Standard System; the System itself stays DBMN\'s', async () => {
            const context = memoryStoreContext();
            const systems = new SystemManager(context);
            const source = globalSource([sample]);
            systems.setGlobalSystems(source);

            const updated = await systems.updateSystem('samplewms', { treeTrimPrefix: '/api' });
            expect(updated).to.include({ id: 'samplewms', scope: 'global', treeTrimPrefix: '/api' });
            const listed = await systems.getAllSystems();
            expect(listed.map(s => s.id), 'listed once').to.deep.equal(['samplewms']);
            expect(listed[0]).to.include({ scope: 'global', treeTrimPrefix: '/api' });
            expect(listed[0].config, 'the configuration is still DBMN\'s').to.deep.equal(sample.config);

            let error: Error | undefined;
            try { await systems.updateSystem('samplewms', { name: 'renamed', treeTrimPrefix: '/x' }); } catch (e) { error = e as Error; }
            expect(error?.message).to.match(/global System, maintained by DBMN/);

            // Withdrawn by DBMN: what was linked to it still has a System, the user's own
            source.set([]);
            const after = await systems.getAllSystems();
            expect(after.map(s => [s.id, s.name, s.scope])).to.deep.equal([['samplewms', 'samplewms', undefined]]);
        });
    });

    describe('an own System named like a Standard System is switched to it, without asking', () => {
        async function catalogue() {
            const context = memoryStoreContext();
            const systems = new SystemManager(context);
            const endpoints = new APIEndpointManager(context);
            const environments = new EnvironmentManager(context);
            const operations = new SystemOperationsService(systems, endpoints, environments);
            return { systems, endpoints, environments, operations };
        }

        it('moves its endpoints and environments onto the Standard System, keeps its settings, and it goes', async () => {
            const c = await catalogue();
            const mine = await c.systems.addSystem({ id: 'system_1', name: 'samplewms', treeTrimPrefix: '/api/v1', createdAt: 1 });
            const keep = await c.systems.addSystem({ id: 'system_2', name: 'erp', createdAt: 1 });
            const ep = await c.endpoints.addEndpoint({ name: 'Items', method: 'GET', path: '/api/v1/items', systemId: mine.id });
            const env = await c.environments.addEnvironment({ name: 'Acme', baseUrl: 'https://acme.samplewms.test', systemId: mine.id });
            const untouched = await c.endpoints.addEndpoint({ name: 'Orders', method: 'GET', path: '/orders', systemId: keep.id });
            c.systems.setGlobalSystems(globalSource([sample]));

            const switched = await switchToGlobalSystems(c.systems, c.operations);
            expect(switched.map(s => [s.from.id, s.to.id])).to.deep.equal([['system_1', 'samplewms']]);
            expect((await c.endpoints.getEndpoint(ep.id))?.systemId).to.equal('samplewms');
            expect((await c.environments.getEnvironment(env.id))?.systemId).to.equal('samplewms');
            expect((await c.endpoints.getEndpoint(untouched.id))?.systemId).to.equal('system_2');
            const listed = await c.systems.getAllSystems();
            expect(listed.map(s => s.id)).to.deep.equal(['system_2', 'samplewms']);
            expect(listed[1]).to.include({ scope: 'global', treeTrimPrefix: '/api/v1' });

            expect(await switchToGlobalSystems(c.systems, c.operations), 'nothing left to switch').to.deep.equal([]);
        });

        it('happens when the Standard Systems arrive (signing in, a refresh), and when an own one appears', async () => {
            const c = await catalogue();
            const mine = await c.systems.addSystem({ id: 'system_1', name: 'samplewms', createdAt: 1 });
            const env = await c.environments.addEnvironment({ name: 'Acme', baseUrl: 'https://acme.samplewms.test', systemId: mine.id });
            const source = globalSource([]);
            c.systems.setGlobalSystems(source);
            const wired = wireGlobalSystemSwitch(c.systems, c.operations);
            await tick();
            expect((await c.environments.getEnvironment(env.id))?.systemId, 'no Standard System yet').to.equal('system_1');

            source.set([sample]);
            for (let i = 0; i < 5; i++) await tick();
            expect((await c.environments.getEnvironment(env.id))?.systemId).to.equal('samplewms');
            expect((await c.systems.getAllSystems()).map(s => s.id)).to.deep.equal(['samplewms']);

            // An Import (signed out, say) made an own one again: switched too
            await c.systems.addSystem({ id: 'system_9', name: 'samplewms-x', createdAt: 1 });
            const again = await c.systems.addSystem({ id: 'system_10', name: 'otherwms', createdAt: 1 });
            source.set([sample, other]);
            for (let i = 0; i < 5; i++) await tick();
            const ids = (await c.systems.getAllSystems()).map(s => s.id);
            expect(ids).to.not.include(again.id);
            expect(ids).to.include('system_9');
            wired.dispose();
        });
    });

    it('Import matches a Standard System by name, as it does the user\'s own (#290)', () => {
        const plan = planImportedSystems(
            [{ id: 'ep-1', name: 'Items', method: 'GET', path: '/items', headers: {}, queryParams: {}, systemName: 'samplewms' }],
            [],
            [own('system_1', 'mine'), sample]
        );
        expect(plan.systemsToCreate).to.deep.equal([]);
        expect(plan.resolve<{ systemId?: string; systemName?: string }>({ systemName: 'samplewms' }).systemId).to.equal('samplewms');
    });
});

describe('#415: an environment with no System is linked to the Standard System its address matches', () => {
    async function catalogue() {
        const context = memoryStoreContext();
        const systems = new SystemManager(context);
        const endpoints = new APIEndpointManager(context);
        const environments = new EnvironmentManager(context);
        const operations = new SystemOperationsService(systems, endpoints, environments);
        return { systems, endpoints, environments, operations };
    }

    it('picks System-less environments whose host matches; one on an own System, or matching nothing, is left alone', () => {
        const links = environmentsToLink([
            { id: 'a', name: 'Acme', baseUrl: 'https://acme.samplewms.test/api', systemId: undefined },
            { id: 'b', name: 'Own', baseUrl: 'https://own.samplewms.test', systemId: 'system_1' },
            { id: 'c', name: 'Elsewhere', baseUrl: 'https://erp.example.com', systemId: undefined },
            { id: 'd', name: 'Other', baseUrl: 'https://x.other.test', systemId: '' }
        ], [sample, other, own('system_1', 'mine')]);
        expect(links.map(l => [l.environment.id, l.to.id])).to.deep.equal([['a', 'samplewms'], ['d', 'otherwms']]);
    });

    it('links them as soon as the Standard Systems arrive, on this device, and again when an environment appears', async () => {
        const c = await catalogue();
        const env = await c.environments.addEnvironment({ name: 'Acme', baseUrl: 'https://acme.samplewms.test' });
        const mine = await c.systems.addSystem({ id: 'system_1', name: 'mine', createdAt: 1 });
        const kept = await c.environments.addEnvironment({ name: 'Own', baseUrl: 'https://own.samplewms.test', systemId: mine.id });
        const source = globalSource([]);
        c.systems.setGlobalSystems(source);
        const wired = wireGlobalSystemSwitch(c.systems, c.operations, c.environments);
        await tick();
        expect((await c.environments.getEnvironment(env.id))?.systemId, 'no Standard System yet').to.equal(undefined);

        source.set([sample]);
        for (let i = 0; i < 5; i++) await tick();
        expect((await c.environments.getEnvironment(env.id))?.systemId).to.equal('samplewms');
        expect((await c.environments.getEnvironment(kept.id))?.systemId, 'the user put it on an own System').to.equal('system_1');

        // An Import, say, brought another environment with no System
        const later = await c.environments.addEnvironment({ name: 'Beta', baseUrl: 'https://beta.samplewms.test' });
        for (let i = 0; i < 5; i++) await tick();
        expect((await c.environments.getEnvironment(later.id))?.systemId).to.equal('samplewms');
        wired.dispose();

        expect(await linkEnvironmentsToGlobalSystems(c.environments, c.systems), 'nothing left to link').to.deep.equal([]);
    });
});
