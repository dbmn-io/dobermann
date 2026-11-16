// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { CatalogueState } from '../../../services/catalogue/catalogue-state';
import { CATALOGUE_KEYS, KeyValueCatalogStore } from '../../../services/catalogue/key-value-catalog-store';
import {
    AccountCopy, MirroredCatalogStore, OfflineCatalogStore, offlineChangesMessage, prefixedStore, sendOfflineChanges
} from '../../../services/catalogue/account-copy';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import type { ISecretStore } from '../../../platform/interfaces/secret-store.interface';
import type { EnvironmentCollection, EnvironmentConfig } from '../../../environmentManager';
import type { APIEndpointCollection } from '../../../apiConfigManager';
import type { Versioned } from '../../../services/catalogue/catalogue.types';

/**
 * #427: signed out is offline. The managers keep working on this computer's copy of the
 * account's catalogue, and what changed here goes to the account at the next sign-in.
 */
class MemoryVault implements ISecretStore {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

const production = {
    id: 'env-prod', name: 'Production', baseUrl: 'https://api.example.com', authMethod: 'oauth',
    oauthConfig: { provider: 'custom', clientId: 'c-1', clientSecret: 'super-secret', authorizationUrl: 'a', tokenUrl: 't', usePKCE: true }
};
const endpoint = { id: 'ep-1', name: 'Get Carriers', method: 'GET', path: '/reference/carriers' };

/** One computer: its device state and vault, and the account's catalogue somewhere else. */
function computer() {
    const globalState = new MemoryKeyValueStore();
    const device = prefixedStore(globalState, 'catalogue:production:user-1:');
    const vault = new MemoryVault();
    const copy = () => new AccountCopy(prefixedStore(globalState, 'catalogue:production:user-1:copy:'));
    return {
        globalState, device, vault, copy,
        async signedIn(remote: KeyValueCatalogStore) {
            const state = new CatalogueState(new MirroredCatalogStore(remote, copy()), device, vault);
            await state.load();
            return state;
        },
        async signedOut() {
            const state = new CatalogueState(new OfflineCatalogStore(copy()), device, vault);
            await state.load();
            return state;
        }
    };
}

const environmentsOf = (state: CatalogueState) => state.globalState.get<EnvironmentCollection>('environments')!.environments;
const endpointsOf = (state: CatalogueState) => state.globalState.get<APIEndpointCollection>('apiEndpoints')!.endpoints;
const settle = (state: CatalogueState) => state.reload();

async function setEnvironments(state: CatalogueState, environments: unknown[]) {
    await state.globalState.update('environments', { environments, folders: [], activeEnvironmentId: undefined, version: '1.2.0' });
}

/** The account's catalogue, changed from somewhere else (the web app, another computer) at `updatedAt`. */
async function changeInAccount(remoteKv: MemoryKeyValueStore, environment: Record<string, unknown>, updatedAt: number) {
    const all = remoteKv.get<Record<string, Versioned<unknown>>>(CATALOGUE_KEYS.environments, {});
    const current = all[environment.id as string];
    await remoteKv.update(CATALOGUE_KEYS.environments, { ...all, [environment.id as string]: { item: environment, version: (current?.version ?? 0) + 1, updatedAt } });
}

describe('Account copy: signed out is offline (#427)', () => {
    it('signed out, the catalogue is still there, secrets included, and survives a reload', async () => {
        const remote = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const pc = computer();
        const online = await pc.signedIn(remote);
        await setEnvironments(online, [production]);
        await online.globalState.update('apiEndpoints', { endpoints: [endpoint], folders: [], version: '1.1.0' });
        await settle(online);

        const offline = await pc.signedOut();
        expect(environmentsOf(offline).map(e => e.name)).to.deep.equal(['Production']);
        expect((environmentsOf(offline)[0] as EnvironmentConfig).oauthConfig?.clientSecret).to.equal('super-secret');
        expect(endpointsOf(offline).map(e => e.name)).to.deep.equal(['Get Carriers']);

        // Made while signed out, then VS Code reloads: still there
        await setEnvironments(offline, [...environmentsOf(offline), { id: 'env-new', name: 'Made offline', baseUrl: 'https://new.example.com' }]);
        await settle(offline);
        const afterReload = await pc.signedOut();
        expect(environmentsOf(afterReload).map(e => e.name)).to.deep.equal(['Production', 'Made offline']);
        expect(pc.copy().pending()).to.deep.equal([{ kind: 'environments', id: 'env-new', change: 'created' }]);
    });

    it('the copy never holds a secret', async () => {
        const remote = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const pc = computer();
        const online = await pc.signedIn(remote);
        await setEnvironments(online, [production]);
        await settle(online);
        const offline = await pc.signedOut();
        await setEnvironments(offline, [{ ...production, name: 'Production (edited offline)' }]);
        await settle(offline);
        expect(JSON.stringify(pc.globalState.get(`catalogue:production:user-1:copy:${CATALOGUE_KEYS.environments}`))).not.to.contain('super-secret');
    });

    it('signing in sends what was made, changed and deleted here, and nothing else changes', async () => {
        const remoteKv = new MemoryKeyValueStore();
        const remote = new KeyValueCatalogStore(remoteKv);
        const pc = computer();
        const online = await pc.signedIn(remote);
        const staging = { id: 'env-stg', name: 'Staging', baseUrl: 'https://stg.example.com' };
        const test = { id: 'env-test', name: 'Test', baseUrl: 'https://test.example.com' };
        await setEnvironments(online, [production, staging, test]);
        await settle(online);

        const offline = await pc.signedOut();
        await setEnvironments(offline, [
            { ...production, name: 'Production EU' },                               // changed
            staging,                                                                 // untouched
            { id: 'env-new', name: 'Made offline', baseUrl: 'https://new.example.com' } // new; Test deleted
        ]);
        await settle(offline);

        const result = await sendOfflineChanges(remote, pc.copy());
        expect(result).to.deep.equal({ sent: 3, conflicts: [] });
        expect(offlineChangesMessage(result)).to.equal('Sent 3 changes you made while signed out to your DBMN account.');
        expect(pc.copy().pending()).to.deep.equal([]);

        const back = await pc.signedIn(remote);
        expect(environmentsOf(back).map(e => e.name).sort()).to.deep.equal(['Made offline', 'Production EU', 'Staging']);
        expect((environmentsOf(back).find(e => e.id === 'env-prod') as EnvironmentConfig).oauthConfig?.clientSecret).to.equal('super-secret');
        expect(offlineChangesMessage(await sendOfflineChanges(remote, pc.copy()))).to.equal(undefined);
    });

    it('changed in both places: the newer one wins, the other is kept as a copy with this device\'s secrets', async () => {
        const remoteKv = new MemoryKeyValueStore();
        const remote = new KeyValueCatalogStore(remoteKv);
        const pc = computer();
        const online = await pc.signedIn(remote);
        await setEnvironments(online, [production]);
        await settle(online);

        const offline = await pc.signedOut();
        await setEnvironments(offline, [{ ...production, baseUrl: 'https://offline.example.com' }]);
        await settle(offline);
        // The web app changed it later than this computer did
        const { clientSecret: _secret, ...oauthWithoutSecret } = production.oauthConfig;
        await changeInAccount(remoteKv, { ...production, oauthConfig: oauthWithoutSecret, baseUrl: 'https://web.example.com' }, Date.now() + 60_000);

        const copied: string[] = [];
        const result = await sendOfflineChanges(remote, pc.copy(), {
            newId: () => 'env-copy',
            onCopied: async (kind, from, to) => { copied.push(`${kind} ${from} → ${to}`); }
        });
        expect(result.conflicts).to.deep.equal([{ kind: 'environments', name: 'Production', kept: 'account', copyName: 'Production (copy)' }]);
        expect(copied).to.deep.equal(['environments env-prod → env-copy']);
        expect(offlineChangesMessage(result)).to.equal('Sent 1 change you made while signed out to your DBMN account. ' +
            'The environment "Production" was changed in both places: your account\'s, the newer one, is kept, and the other is saved as "Production (copy)".');

        const back = await pc.signedIn(remote);
        const byId = Object.fromEntries(environmentsOf(back).map(e => [e.id, e]));
        expect(byId['env-prod'].baseUrl).to.equal('https://web.example.com');
        expect(byId['env-copy'].baseUrl).to.equal('https://offline.example.com');
        expect(byId['env-copy'].name).to.equal('Production (copy)');
    });

    it('changed in both places, this computer later: its change is kept and the account\'s is the copy', async () => {
        const remoteKv = new MemoryKeyValueStore();
        const remote = new KeyValueCatalogStore(remoteKv);
        const pc = computer();
        const online = await pc.signedIn(remote);
        await setEnvironments(online, [production]);
        await settle(online);
        await changeInAccount(remoteKv, { ...production, baseUrl: 'https://web.example.com' }, Date.now() - 60_000);

        const offline = await pc.signedOut();
        await setEnvironments(offline, [{ ...production, baseUrl: 'https://offline.example.com' }]);
        await settle(offline);

        const result = await sendOfflineChanges(remote, pc.copy(), { newId: () => 'env-copy' });
        expect(result.conflicts[0]).to.include({ kept: 'here', copyName: 'Production (copy)' });
        const back = await pc.signedIn(remote);
        const byId = Object.fromEntries(environmentsOf(back).map(e => [e.id, e]));
        expect(byId['env-prod'].baseUrl).to.equal('https://offline.example.com');
        expect(byId['env-copy'].baseUrl).to.equal('https://web.example.com');
    });

    it('deleted here but changed in the account: kept. Deleted in the account but changed here: made again', async () => {
        const remoteKv = new MemoryKeyValueStore();
        const remote = new KeyValueCatalogStore(remoteKv);
        const pc = computer();
        const online = await pc.signedIn(remote);
        const staging = { id: 'env-stg', name: 'Staging', baseUrl: 'https://stg.example.com' };
        await setEnvironments(online, [production, staging]);
        await settle(online);

        const offline = await pc.signedOut();
        await setEnvironments(offline, [{ ...staging, name: 'Staging 2' }]);   // Production deleted here
        await settle(offline);
        await changeInAccount(remoteKv, { ...production, name: 'Production (web)' }, Date.now());
        await remote.environments.delete('env-stg');

        const result = await sendOfflineChanges(remote, pc.copy());
        expect(result.sent).to.equal(1);
        const back = await pc.signedIn(remote);
        expect(environmentsOf(back).map(e => e.name).sort()).to.deep.equal(['Production (web)', 'Staging 2']);
    });

    it('a sign-in that fails half way sends only the rest next time', async () => {
        const remoteKv = new MemoryKeyValueStore();
        const remote = new KeyValueCatalogStore(remoteKv);
        const pc = computer();
        await pc.signedIn(remote);
        const offline = await pc.signedOut();
        await setEnvironments(offline, [{ id: 'env-a', name: 'A', baseUrl: 'https://a.example.com' }, { id: 'env-b', name: 'B', baseUrl: 'https://b.example.com' }]);
        await settle(offline);

        let saves = 0;
        const save = remote.environments.save.bind(remote.environments);
        remote.environments.save = async (item, version) => {
            if (++saves === 2) throw new Error('network down');
            return save(item, version);
        };
        let failed = false;
        try { await sendOfflineChanges(remote, pc.copy()); } catch { failed = true; }
        expect(failed).to.equal(true);
        expect(pc.copy().pending()).to.have.length(1);

        const result = await sendOfflineChanges(remote, pc.copy());
        expect(result.sent).to.equal(1);
        expect((await remote.environments.list()).map(r => r.item.name).sort()).to.deep.equal(['A', 'B']);
    });

    it('signed out, run counters carry on from this device, never from the copy', async () => {
        const remote = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const pc = computer();
        const online = await pc.signedIn(remote);
        await online.globalState.update('apiEndpoints', { endpoints: [endpoint], folders: [], version: '1.1.0' });
        await settle(online);
        expect(await online.runCounters.next('ep-1')).to.equal(1);
        expect(await online.runCounters.next('ep-1')).to.equal(2);
        await online.runCounters.flush();

        const offline = await pc.signedOut();
        let warned = 0;
        offline.onCountersLocal = () => { warned++; };
        expect(await offline.runCounters.next('ep-1')).to.equal(3);
        expect(await offline.runCounters.next('ep-1')).to.equal(4);
        expect(warned).to.equal(1);

        // Signed in again: the account jumps past what this device handed out
        const back = await pc.signedIn(remote);
        expect(await back.runCounters.next('ep-1')).to.equal(5);
    });

    it('cleared, there is nothing to work on signed out', async () => {
        const remote = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const pc = computer();
        const online = await pc.signedIn(remote);
        await setEnvironments(online, [production]);
        await settle(online);
        expect(pc.copy().exists).to.equal(true);
        expect(pc.copy().environmentIds()).to.deep.equal(['env-prod']);
        await pc.copy().clear();
        expect(pc.copy().exists).to.equal(false);
        expect(environmentsOf(await pc.signedOut())).to.deep.equal([]);
    });
});
