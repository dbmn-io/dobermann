// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { CatalogueState } from '../../../services/catalogue/catalogue-state';
import { KeyValueCatalogStore } from '../../../services/catalogue/key-value-catalog-store';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import type { ISecretStore } from '../../../platform/interfaces/secret-store.interface';

/**
 * #342/#362: the catalogue for both hosts. Shared items go to the catalogue in the safe form;
 * device state stays on the device; secrets stay in the device's vault, never plain state.
 */
class MemoryVault implements ISecretStore {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

const environment = {
    id: 'env-ss', name: 'Sample Store', baseUrl: 'http://127.0.0.1:54321/functions/v1/sample-store',
    authMethod: 'oauth', isActive: true, lastUsed: '2026-10-07T00:00:00Z',
    oauthConfig: { provider: 'custom', clientId: 'gd-1', clientSecret: 'super-secret', authorizationUrl: 'a', tokenUrl: 't', usePKCE: true },
    headers: { 'X-Api-Key': { value: 'header-secret', enabled: true, secret: true }, 'X-Plain': { value: 'plain', enabled: true } },
    variables: { tenant: 'acme', password: 'variable-secret' },
    secretVariables: ['password']
};
const endpoint = { id: 'ep-1', name: 'Get Carriers', method: 'GET', path: '/reference/carriers', sequenceCounter: 42 };

function deviceFor() { return { device: new MemoryKeyValueStore(), vault: new MemoryVault() }; }

async function save(state: CatalogueState) {
    await state.globalState.update('environments', { environments: [environment], folders: [], activeEnvironmentId: 'env-ss', version: '1.2.0' });
    await state.globalState.update('apiEndpoints', { endpoints: [endpoint], folders: [], version: '1.1.0' });
}

describe('CatalogueState: catalogue, device state and vault (#342, #362)', () => {
    it('the catalogue gets the safe form: no secrets, no device state', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const { device, vault } = deviceFor();
        await save(new CatalogueState(catalogue, device, vault));
        const [row] = await catalogue.environments.list();
        const shared = JSON.stringify(row.item);
        for (const secret of ['super-secret', 'header-secret', 'variable-secret']) expect(shared).to.not.contain(secret);
        expect(row.item).to.not.have.property('isActive');
        expect(row.item).to.not.have.property('lastUsed');
        const [ep] = await catalogue.endpoints.list();
        expect(ep.item).to.not.have.property('sequenceCounter');
    });

    it('device state never holds a secret; the vault holds them', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const { device, vault } = deviceFor();
        await save(new CatalogueState(catalogue, device, vault));
        const deviceDump = JSON.stringify(device.keys().map(k => device.get(k)));
        for (const secret of ['super-secret', 'header-secret', 'variable-secret']) expect(deviceDump, 'plain device state').to.not.contain(secret);
        expect(deviceDump).to.contain('2026-10-07T00:00:00Z');
        const vaulted = JSON.parse(vault.values.get('catalogue-secrets:environment:env-ss')!);
        expect(vaulted).to.deep.equal({ clientSecret: 'super-secret', headers: { 'X-Api-Key': 'header-secret' }, variables: { password: 'variable-secret' } });
    });

    it('this device loads it back whole: shared item + its state + its secrets', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const { device, vault } = deviceFor();
        await save(new CatalogueState(catalogue, device, vault));
        const again = new CatalogueState(catalogue, device, vault);
        await again.load();
        const envs = again.globalState.get<{ environments: typeof environment[]; activeEnvironmentId?: string }>('environments')!;
        expect(envs.activeEnvironmentId).to.equal('env-ss');
        expect(envs.environments[0]).to.deep.include({ isActive: true, lastUsed: '2026-10-07T00:00:00Z' });
        expect(envs.environments[0].oauthConfig.clientSecret).to.equal('super-secret');
        expect(envs.environments[0].headers['X-Api-Key'].value).to.equal('header-secret');
        expect(envs.environments[0].variables.password).to.equal('variable-secret');
        const eps = again.globalState.get<{ endpoints: typeof endpoint[] }>('apiEndpoints')!;
        expect(eps.endpoints[0].sequenceCounter).to.equal(42);
    });

    it('another device sees the shared environment, without this device\'s secrets or state', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const first = deviceFor();
        await save(new CatalogueState(catalogue, first.device, first.vault));
        const second = deviceFor();
        const other = new CatalogueState(catalogue, second.device, second.vault);
        await other.load();
        const env = other.globalState.get<{ environments: typeof environment[] }>('environments')!.environments[0];
        expect(env.name).to.equal('Sample Store');
        expect(env.oauthConfig.clientId).to.equal('gd-1');
        expect(env.oauthConfig).to.not.have.property('clientSecret');
        expect(env.headers['X-Api-Key'].value).to.equal('');
        expect(env).to.not.have.property('isActive');
    });

    it('a device copy from before #342 (whole environment, secrets in plain state) moves its secrets to the vault', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const seed = deviceFor();
        await save(new CatalogueState(catalogue, seed.device, seed.vault));
        const device = new MemoryKeyValueStore({ 'device:environments': { 'env-ss': environment } });
        const vault = new MemoryVault();
        const state = new CatalogueState(catalogue, device, vault);
        await state.load();
        expect(state.globalState.get<{ environments: typeof environment[] }>('environments')!.environments[0].oauthConfig.clientSecret).to.equal('super-secret');
        expect(vault.values.has('catalogue-secrets:environment:env-ss')).to.equal(true);
        await state.globalState.update('environments', state.globalState.get('environments'));
        expect(JSON.stringify(device.get('device:environments'))).to.not.contain('super-secret');
    });

    it('deleting an environment deletes its secrets', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const { device, vault } = deviceFor();
        const state = new CatalogueState(catalogue, device, vault);
        await save(state);
        await state.globalState.update('environments', { environments: [], folders: [], version: '1.2.0' });
        expect(vault.values.size).to.equal(0);
        expect(await catalogue.environments.list()).to.have.length(0);
    });

    it('other keys are device state; secrets is the vault (env tokens keep their keys)', async () => {
        const { device, vault } = deviceFor();
        const state = new CatalogueState(new KeyValueCatalogStore(new MemoryKeyValueStore()), device, vault);
        await state.globalState.update('recentEndpoints', ['ep-1']);
        expect(device.get('recentEndpoints')).to.deep.equal(['ep-1']);
        await state.secrets.store('env_token_env-ss', 'jwt');
        expect(vault.values.get('env_token_env-ss')).to.equal('jwt');
    });
});

describe('Uploading a device\'s catalogue once (#342)', () => {
    it('uploads systems, endpoints and environments; secrets stay in the vault', async () => {
        const { addDeviceCatalogue, deviceCatalogueMissing } = await import('../../../services/catalogue/catalogue-upload');
        const localState = new MemoryKeyValueStore({
            apiSystems: { systems: [{ id: 'sys-1', name: 'WMS' }, { id: 'sys-unsorted', name: 'Unsorted' }], version: '1.0.0' },
            apiEndpoints: { endpoints: [{ ...endpoint, systemId: 'sys-1' }], folders: [], version: '1.1.0' },
            environments: { environments: [environment], folders: [], activeEnvironmentId: 'env-ss', version: '1.2.0' }
        });
        const local = { globalState: localState, secrets: new MemoryVault() };
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const { device, vault } = deviceFor();
        const shared = new CatalogueState(catalogue, device, vault);
        await shared.load();
        expect(shared.isEmpty).to.equal(true);
        expect(deviceCatalogueMissing(local, shared)).to.deep.equal({ ids: ['ep-1', 'env-ss'], endpoints: 1, environments: 1 });

        expect(await addDeviceCatalogue(local, shared)).to.equal(2);
        expect(shared.isEmpty).to.equal(false);
        expect((await catalogue.systems.list()).map(r => r.item.id).sort(), 'every System, used or not').to.deep.equal(['sys-1', 'sys-unsorted']);
        expect((await catalogue.endpoints.list()).map(r => r.item.id)).to.deep.equal(['ep-1']);
        expect(JSON.stringify(await catalogue.environments.list())).to.not.contain('super-secret');
        expect(vault.values.has('catalogue-secrets:environment:env-ss')).to.equal(true);
        expect(localState.get('apiEndpoints'), 'adding leaves the local store as it was').to.not.equal(undefined);
    });

    it('into an account that already has items: only what it lacks, by id; the account\'s copy wins', async () => {
        const { addDeviceCatalogue, deviceCatalogueMissing } = await import('../../../services/catalogue/catalogue-upload');
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        await catalogue.endpoints.save({ ...endpoint, name: 'Get Carriers (edited in the web app)' } as never, 0);
        await catalogue.environments.save({ id: 'env-web', name: 'Made in the web app', baseUrl: 'http://web' } as never, 0);
        const { device, vault } = deviceFor();
        const shared = new CatalogueState(catalogue, device, vault);
        await shared.load();
        const local = {
            globalState: new MemoryKeyValueStore({
                apiEndpoints: { endpoints: [endpoint, { id: 'ep-2', name: 'Only on this device', method: 'GET', path: '/x' }], folders: [], version: '1.1.0' },
                environments: { environments: [environment, { id: 'd', name: 'Default', isActive: false }], folders: [], activeEnvironmentId: 'env-ss', version: '1.2.0' }
            }),
            secrets: new MemoryVault()
        };
        expect(deviceCatalogueMissing(local, shared).ids).to.deep.equal(['ep-2', 'env-ss']);

        expect(await addDeviceCatalogue(local, shared)).to.equal(2);
        const endpoints = (await catalogue.endpoints.list()).map(r => (r.item as { name: string }).name).sort();
        expect(endpoints).to.deep.equal(['Get Carriers (edited in the web app)', 'Only on this device']);
        expect((await catalogue.environments.list()).map(r => r.item.id).sort()).to.deep.equal(['env-ss', 'env-web']);
        expect(JSON.stringify(await catalogue.environments.list())).to.not.contain('super-secret');
        expect(shared.globalState.get<{ activeEnvironmentId?: string }>('environments')?.activeEnvironmentId, 'the account had none active: this device\'s').to.equal('env-ss');
        expect(deviceCatalogueMissing(local, shared).ids, 'nothing left to add').to.deep.equal([]);
    });

    it('a device System named like the account\'s joins it: no second "dbmn"', async () => {
        const { addDeviceCatalogue } = await import('../../../services/catalogue/catalogue-upload');
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        await catalogue.systems.save({ id: 'sys-web', name: 'dbmn' } as never, 0);
        const { device, vault } = deviceFor();
        const shared = new CatalogueState(catalogue, device, vault);
        await shared.load();
        const local = {
            globalState: new MemoryKeyValueStore({
                apiSystems: { systems: [{ id: 'sys-vscode', name: 'DBMN ' }, { id: 'sys-wms', name: 'WMS' }], version: '1.0.0' },
                apiEndpoints: { endpoints: [{ ...endpoint, systemId: 'sys-vscode' }, { id: 'ep-wms', name: 'WMS one', method: 'GET', path: '/w', systemId: 'sys-wms' }], folders: [], version: '1.1.0' },
                environments: { environments: [{ ...environment, systemId: 'sys-vscode' }], folders: [], version: '1.2.0' }
            }),
            secrets: new MemoryVault()
        };
        await addDeviceCatalogue(local, shared);
        expect((await catalogue.systems.list()).map(r => (r.item as { name: string }).name).sort()).to.deep.equal(['WMS', 'dbmn']);
        const systemOf = async (kind: 'endpoints' | 'environments', id: string) => {
            const rows: Array<{ item: { id: string } }> = kind === 'endpoints' ? await catalogue.endpoints.list() : await catalogue.environments.list();
            return (rows.find(r => r.item.id === id)!.item as { systemId?: string }).systemId;
        };
        expect(await systemOf('endpoints', 'ep-1')).to.equal('sys-web');
        expect(await systemOf('environments', 'env-ss')).to.equal('sys-web');
        expect(await systemOf('endpoints', 'ep-wms')).to.equal('sys-wms');
    });

    it('the same item made twice (web app and VS Code: two ids) moves once; the duplicate environment\'s secrets serve the account\'s', async () => {
        const { addDeviceCatalogue, deviceCatalogueMissing, deviceEnvironmentsForVault } = await import('../../../services/catalogue/catalogue-upload');
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        await catalogue.systems.save({ id: 'sys-web', name: 'dbmn' } as never, 0);
        await catalogue.endpoints.save({ id: 'ep-web', name: 'Get Carriers', method: 'GET', path: '/reference/carriers', systemId: 'sys-web' } as never, 0);
        await catalogue.environments.save({ id: 'env-web', name: 'Sample Store', baseUrl: 'http://127.0.0.1:54321/functions/v1/sample-store/' } as never, 0);
        const { device, vault } = deviceFor();
        const shared = new CatalogueState(catalogue, device, vault);
        await shared.load();
        const local = {
            globalState: new MemoryKeyValueStore({
                apiSystems: { systems: [{ id: 'sys-vscode', name: 'dbmn' }], version: '1.0.0' },
                apiEndpoints: { endpoints: [
                    { id: 'ep-vscode', name: 'Get Carriers ', method: 'get', path: '/reference/carriers', systemId: 'sys-vscode' },
                    { id: 'ep-other', name: 'Get Carriers', method: 'GET', path: '/reference/carriers' }
                ], folders: [], version: '1.1.0' },
                environments: { environments: [environment], folders: [], version: '1.2.0' }
            }),
            secrets: new MemoryVault()
        };
        expect(deviceCatalogueMissing(local, shared), 'the one in no System is another endpoint').to.deep.equal({ ids: ['ep-other'], endpoints: 1, environments: 0 });
        const forVault = deviceEnvironmentsForVault(local, shared);
        await addDeviceCatalogue(local, shared);
        await shared.adoptSecrets(forVault as never);
        expect((await catalogue.endpoints.list()).map(r => r.item.id).sort()).to.deep.equal(['ep-other', 'ep-web']);
        expect((await catalogue.environments.list()).map(r => r.item.id)).to.deep.equal(['env-web']);
        expect(JSON.parse(vault.values.get('catalogue-secrets:environment:env-web')!)).to.deep.include({ clientSecret: 'super-secret' });
    });

    it('a new install\'s placeholder environment (no base URL) is not worth asking about', async () => {
        const { deviceCatalogueMissing, describeCatalogueCount } = await import('../../../services/catalogue/catalogue-upload');
        const fresh = {
            globalState: new MemoryKeyValueStore({
                environments: { environments: [{ id: 'd', name: 'Default', isActive: true, systemId: 'sys-unsorted' }], folders: [], version: '1.2.0' },
                apiSystems: { systems: [{ id: 'sys-unsorted', name: 'Unsorted' }], version: '1.0.0' }
            }),
            secrets: new MemoryVault()
        };
        const empty = new CatalogueState(new KeyValueCatalogStore(new MemoryKeyValueStore()), new MemoryKeyValueStore(), new MemoryVault());
        await empty.load();
        expect(deviceCatalogueMissing(fresh, empty).ids).to.deep.equal([]);
        expect(describeCatalogueCount(1, 2)).to.equal('1 endpoint and 2 environments');
        expect(describeCatalogueCount(3, 0)).to.equal('3 endpoints');
    });

    it('the one-time move: the device\'s copy is left as it was, and hidden from this version signed out; an environment the account had still gets its secrets in the vault', async () => {
        const { addDeviceCatalogue, deviceEnvironmentsForVault, deviceHasCatalogue } = await import('../../../services/catalogue/catalogue-upload');
        const { withoutDeviceCatalogue } = await import('../../../services/catalogue/switchable-store-context');
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const { device, vault } = deviceFor();
        const shared = new CatalogueState(catalogue, device, vault);
        await shared.load();
        await shared.globalState.update('environments', { environments: [environment], folders: [], version: '1.2.0' });   // already in the account
        vault.values.clear();                                                                                              // ...but not this device's vault
        await shared.reload();
        const localState = new MemoryKeyValueStore({
            apiEndpoints: { endpoints: [endpoint], folders: [], version: '1.1.0' },
            environments: { environments: [environment], folders: [], activeEnvironmentId: 'env-ss', version: '1.2.0' },
            otherSetting: 'kept'
        });
        const local = { globalState: localState, secrets: new MemoryVault() };
        expect(deviceHasCatalogue(local)).to.equal(true);

        const forVault = deviceEnvironmentsForVault(local, shared);
        await addDeviceCatalogue(local, shared);
        await shared.adoptSecrets(forVault as never);
        const before = JSON.stringify(localState.get('apiEndpoints')) + JSON.stringify(localState.get('environments'));

        expect(JSON.parse(vault.values.get('catalogue-secrets:environment:env-ss')!)).to.deep.include({ clientSecret: 'super-secret' });
        const loaded = shared.globalState.get<{ environments: Array<{ oauthConfig: { clientSecret?: string } }> }>('environments')!;
        expect(loaded.environments[0].oauthConfig.clientSecret, 'on the loaded environment').to.equal('super-secret');
        expect(deviceHasCatalogue(local), 'the device\'s copy is still there, for older versions').to.equal(true);

        const signedOut = withoutDeviceCatalogue(local);
        expect(signedOut.globalState.get('apiEndpoints'), 'signed out, this version sees no catalogue').to.equal(undefined);
        await signedOut.globalState.update('apiEndpoints', { endpoints: [{ id: 'ep-new' }], folders: [], version: '1.1.0' });
        expect(signedOut.globalState.get<{ endpoints: unknown[] }>('apiEndpoints')!.endpoints).to.have.length(1);
        expect(signedOut.globalState.get('otherSetting'), 'other keys are the device\'s').to.equal('kept');
        expect(JSON.stringify(localState.get('apiEndpoints')) + JSON.stringify(localState.get('environments')), 'nothing on the device changed').to.equal(before);
    });

    it('reload waits for this device\'s own writes, then shows the catalogue as stored', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const { device, vault } = deviceFor();
        const state = new CatalogueState(catalogue, device, vault);
        await state.load();
        const saving = state.globalState.update('apiEndpoints', { endpoints: [endpoint], folders: [], version: '1.1.0' });
        await state.reload();
        expect(state.globalState.get<{ endpoints: unknown[] }>('apiEndpoints')!.endpoints).to.have.length(1);
        await saving;
    });
});
