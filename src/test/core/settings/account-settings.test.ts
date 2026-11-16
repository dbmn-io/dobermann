// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { AccountSettings, type AccountSettingsStore, type SettingsMap } from '../../../services/settings/account-settings';
import type { IWritableConfiguration } from '../../../platform/interfaces/configuration.interface';

/** #281: settings that follow the user come from the account while signed in; the rest stay the host's. */
class MemorySettingsStore implements AccountSettingsStore {
    values: SettingsMap = {};
    listener?: (settings: SettingsMap) => void;
    disposed = false;
    async load() { return { ...this.values }; }
    async set(name: string, value: unknown) {
        if (value === undefined || value === null) delete this.values[name]; else this.values[name] = value;
        return { ...this.values };
    }
    async follow(onChanged: (settings: SettingsMap) => void) { this.listener = onChanged; }
    async dispose() { this.disposed = true; }
    /** Another device changed something. */
    elsewhere(name: string, value: unknown) { this.values[name] = value; this.listener?.({ ...this.values }); }
}

function hostSettings(initial: SettingsMap = {}): IWritableConfiguration & { values: SettingsMap } {
    const values = { ...initial };
    return {
        values,
        get: <T>(section: string, key: string, defaultValue: T) => (`${section}.${key}` in values ? values[`${section}.${key}`] as T : defaultValue),
        update: async (section: string, key: string, value: unknown) => { values[`${section}.${key}`] = value; }
    };
}

const log = () => undefined;

describe('Settings that follow the user (#281)', () => {
    it('signed in: roaming settings from the account (either section split), the rest from the host', async () => {
        const host = hostSettings({ 'dbmn.execution.maxCsvRows': 5000, 'dbmn.oauth.redirectUri': 'vscode://x' });
        const store = new MemorySettingsStore();
        store.values['dbmn.execution.maxCsvRows'] = 250000;
        const settings = new AccountSettings(host);

        expect(settings.get('dbmn', 'execution.maxCsvRows', 100000), 'signed out').to.equal(5000);
        await settings.connect(store, log);
        expect(settings.get('dbmn', 'execution.maxCsvRows', 100000)).to.equal(250000);
        expect(settings.get('dbmn.execution', 'maxCsvRows', 100000)).to.equal(250000);
        expect(settings.get('dbmn.oauth', 'redirectUri', ''), 'host-only setting').to.equal('vscode://x');
        expect(settings.get('dbmn', 'ui.confirmTransactionDeletion', true), 'not in the account: host, then default').to.equal(true);
    });

    it('writes a roaming setting to the account only, a host setting to the host', async () => {
        const host = hostSettings();
        const store = new MemorySettingsStore();
        const settings = new AccountSettings(host);
        await settings.connect(store, log);

        await settings.update('dbmn', 'ui.confirmTransactionDeletion', false);
        await settings.update('dbmn', 'preloadHubOnStartup', false);
        expect(store.values).to.deep.equal({ 'dbmn.ui.confirmTransactionDeletion': false });
        expect(host.values).to.deep.equal({ 'dbmn.preloadHubOnStartup': false });
    });

    it('a change made on another device shows here and tells the screens', async () => {
        const store = new MemorySettingsStore();
        const settings = new AccountSettings(hostSettings());
        let changes = 0;
        settings.onDidChange(() => changes++);
        await settings.connect(store, log);
        store.elsewhere('dbmn.execution.criticalErrorCodes', [401, 403, 429]);
        expect(settings.get('dbmn', 'execution.criticalErrorCodes', [401, 403])).to.deep.equal([401, 403, 429]);
        expect(changes).to.equal(2);
    });

    it('adopt brings this device\'s values only for settings the account has none for', async () => {
        const store = new MemorySettingsStore();
        store.values['dbmn.execution.maxCsvRows'] = 250000;
        const settings = new AccountSettings(hostSettings());
        await settings.connect(store, log);
        const added = await settings.adopt({
            'dbmn.execution.maxCsvRows': 5000,
            'dbmn.ui.confirmTransactionDeletion': false,
            'dbmn.oauth.redirectUri': 'vscode://never-roams'
        });
        expect(added).to.equal(1);
        expect(store.values).to.deep.equal({ 'dbmn.execution.maxCsvRows': 250000, 'dbmn.ui.confirmTransactionDeletion': false });
    });

    it('signed out: the host\'s again, and the account store is let go', async () => {
        const host = hostSettings({ 'dbmn.execution.maxCsvRows': 5000 });
        const store = new MemorySettingsStore();
        store.values['dbmn.execution.maxCsvRows'] = 250000;
        const settings = new AccountSettings(host);
        await settings.connect(store, log);
        await settings.disconnect();
        expect(settings.get('dbmn', 'execution.maxCsvRows', 100000)).to.equal(5000);
        expect(store.disposed).to.equal(true);
        store.elsewhere('dbmn.execution.maxCsvRows', 1);
        expect(settings.get('dbmn', 'execution.maxCsvRows', 100000), 'no longer following').to.equal(5000);
    });
});
