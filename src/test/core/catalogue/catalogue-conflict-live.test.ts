// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { CatalogueState, conflictMessage, type CatalogueConflict } from '../../../services/catalogue/catalogue-state';
import { KeyValueCatalogStore } from '../../../services/catalogue/key-value-catalog-store';
import { followCatalogueChanges } from '../../../services/catalogue/catalogue-live';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import { EventEmitter } from '../../../platform/events';
import type { CatalogChange } from '../../../services/catalogue/catalog-store.interface';
import type { ISecretStore } from '../../../platform/interfaces/secret-store.interface';

/** #342: the same catalogue open in two places. Kept simple: the second save wins, with a warning. */
class MemoryVault implements ISecretStore {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

type Endpoints = { endpoints: Array<{ id: string; name: string; method: string; path: string }>; folders: []; version: string };

async function twoPlaces() {
    const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
    await catalogue.endpoints.save({ id: 'ep-1', name: 'Get Carriers', method: 'GET', path: '/reference/carriers' } as never, 0);
    const vscode = new CatalogueState(catalogue, new MemoryKeyValueStore(), new MemoryVault());
    const web = new CatalogueState(catalogue, new MemoryKeyValueStore(), new MemoryVault());
    await Promise.all([vscode.load(), web.load()]);
    const conflicts: CatalogueConflict[] = [];
    web.onConflict = c => conflicts.push(c);
    const rename = (state: CatalogueState, name: string) => {
        const current = state.globalState.get<Endpoints>('apiEndpoints')!;
        return state.globalState.update('apiEndpoints', { ...current, endpoints: current.endpoints.map(e => ({ ...e, name })) });
    };
    return { catalogue, vscode, web, conflicts, rename };
}

describe('Editing the same item in two places (#342)', () => {
    it('the second save wins, and says so', async () => {
        const { catalogue, vscode, web, conflicts, rename } = await twoPlaces();
        await rename(vscode, 'Edited in VS Code');
        await rename(web, 'Edited in the web app');   // still holds the version it read
        expect(((await catalogue.endpoints.list())[0].item as { name: string }).name).to.equal('Edited in the web app');
        expect(conflicts).to.deep.equal([{ kind: 'endpoints', name: 'Edited in the web app', deleted: false }]);
        expect(conflictMessage(conflicts[0])).to.equal('The endpoint "Edited in the web app" was changed somewhere else (the web app or another VS Code) since you opened it. Your save replaced that change.');
        await rename(web, 'Again');                     // its version is current now: no warning
        expect(conflicts).to.have.length(1);
    });

    it('a delete over a change made elsewhere still deletes, and says so', async () => {
        const { catalogue, vscode, web, conflicts, rename } = await twoPlaces();
        await rename(vscode, 'Edited in VS Code');
        await web.globalState.update('apiEndpoints', { endpoints: [], folders: [], version: '1.1.0' });
        expect(await catalogue.endpoints.list()).to.deep.equal([]);
        expect(conflicts.map(c => c.deleted)).to.deep.equal([true]);
    });
});

describe('followCatalogueChanges (#342)', () => {
    it('reloads once subscribed, and again (once) after a burst of changes', async () => {
        const changed = new EventEmitter<CatalogChange>();
        let reloads = 0;
        let refreshed = 0;
        const live = followCatalogueChanges(
            { onChanged: changed.event, connect: async () => undefined },
            { reload: async () => { reloads++; } },
            { onReloaded: () => { refreshed++; }, log: () => undefined },
            5
        );
        await live.ready;
        await new Promise(r => setTimeout(r, 20));
        expect([reloads, refreshed], 'the catch-up after subscribing').to.deep.equal([1, 1]);
        for (let i = 0; i < 3; i++) changed.fire({ kind: 'endpoints', id: `ep-${i}`, deleted: false, version: 2 });
        await new Promise(r => setTimeout(r, 20));
        expect([reloads, refreshed]).to.deep.equal([2, 2]);
        live.dispose();
        changed.fire({ kind: 'endpoints', id: 'ep-9', deleted: false, version: 3 });
        await new Promise(r => setTimeout(r, 20));
        expect(reloads, 'nothing after dispose').to.equal(2);
    });
});

describe('followCatalogueChanges: this device\'s own saves (2026-11-13)', () => {
    // James: adding an organisation from the Hub header was "painfully slow". Every save this
    // device made was announced back to it, and reloaded the whole catalogue from the account
    // (then every screen), although the save was in memory already.
    it('a save made here reloads nothing; the same save made somewhere else reloads once', async () => {
        const { catalogue, vscode, web, rename } = await twoPlaces();
        const reloads = { vscode: 0, web: 0 };
        const store = { onChanged: catalogue.onChanged, connect: async () => undefined };
        const here = followCatalogueChanges(store, { reload: async () => { reloads.vscode++; }, isOwnWrite: c => vscode.isOwnWrite(c) }, { onReloaded: () => undefined, log: () => undefined }, 5);
        const there = followCatalogueChanges(store, { reload: async () => { reloads.web++; }, isOwnWrite: c => web.isOwnWrite(c) }, { onReloaded: () => undefined, log: () => undefined }, 5);
        await Promise.all([here.ready, there.ready]);
        await new Promise(r => setTimeout(r, 20));
        reloads.vscode = reloads.web = 0;     // the catch-up after subscribing

        await rename(vscode, 'Edited in VS Code');
        await new Promise(r => setTimeout(r, 20));
        expect(reloads, 'VS Code made the save: only the web app reloads').to.deep.equal({ vscode: 0, web: 1 });
        here.dispose();
        there.dispose();
    });
});
