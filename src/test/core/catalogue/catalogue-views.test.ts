// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { CatalogueState, CONSOLE_VIEWS_KEY } from '../../../services/catalogue/catalogue-state';
import { KeyValueCatalogStore } from '../../../services/catalogue/key-value-catalog-store';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import type { ISecretStore } from '../../../platform/interfaces/secret-store.interface';
import type { ConsoleViewsRegistryV2 } from '../../../services/console/view-scope-key';

/**
 * #365: Console views follow the user. They were device state (`consoleViewsRegistry`); now each
 * view scope (method + path) is a catalogue item, and a device's own views come in once.
 */
class MemoryVault implements ISecretStore {
    async get() { return undefined; }
    async store() { /* none */ }
    async delete() { /* none */ }
}

const carriers = 'GET /reference/carriers';
const orders = 'POST /orders';
const viewsNamed = (name: string) => ({ success: { activeView: name, views: [{ name, columns: ['id'] }] } });

async function deviceOn(catalogue: KeyValueCatalogStore, device = new MemoryKeyValueStore()) {
    const state = new CatalogueState(catalogue, device, new MemoryVault());
    await state.load();
    return { state, device };
}

const registryOf = (state: CatalogueState) => state.globalState.get<ConsoleViewsRegistryV2>(CONSOLE_VIEWS_KEY)!;

describe('Console views in the account (#365)', () => {
    it('a view saved on one device is there on the other', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const laptop = await deviceOn(catalogue);
        await laptop.state.globalState.update(CONSOLE_VIEWS_KEY, { schemaVersion: 2, scopes: { [carriers]: viewsNamed('Carriers') } });

        const web = await deviceOn(catalogue);
        expect(registryOf(web.state).scopes[carriers]).to.deep.equal(viewsNamed('Carriers'));
        expect(web.device.get(CONSOLE_VIEWS_KEY), 'not device state').to.equal(undefined);

        const scopes = { ...registryOf(web.state).scopes };
        delete scopes[carriers];
        await web.state.globalState.update(CONSOLE_VIEWS_KEY, { schemaVersion: 2, scopes });
        await laptop.state.reload();
        expect(registryOf(laptop.state).scopes).to.not.have.property(carriers);
    });

    it('a device\'s own views come in once; a scope the account has keeps the account\'s', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const first = await deviceOn(catalogue);
        await first.state.globalState.update(CONSOLE_VIEWS_KEY, { schemaVersion: 2, scopes: { [carriers]: viewsNamed('Account') } });

        const laptop = await deviceOn(catalogue);
        const own = { schemaVersion: 2, scopes: { [carriers]: viewsNamed('Device'), [orders]: viewsNamed('Orders') } };
        expect(await laptop.state.adoptDeviceViews(own)).to.equal(1);
        expect(registryOf(laptop.state).scopes[carriers]).to.deep.equal(viewsNamed('Account'));
        expect(registryOf(laptop.state).scopes[orders]).to.deep.equal(viewsNamed('Orders'));

        const scopes = { ...registryOf(laptop.state).scopes };
        delete scopes[orders];
        await laptop.state.globalState.update(CONSOLE_VIEWS_KEY, { schemaVersion: 2, scopes });
        expect(await laptop.state.adoptDeviceViews(own), 'once: a deleted view stays deleted').to.equal(0);
        expect(registryOf(laptop.state).scopes).to.not.have.property(orders);
    });

    it('the web app\'s views (on its own device state) come in when it loads', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const browser = new MemoryKeyValueStore();
        await browser.update(CONSOLE_VIEWS_KEY, { schemaVersion: 2, scopes: { [orders]: viewsNamed('Orders') } });
        await deviceOn(catalogue, browser);
        expect((await catalogue.views.get(orders))?.item.views).to.deep.equal(viewsNamed('Orders'));
    });
});
