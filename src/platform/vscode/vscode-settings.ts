// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #281: VS Code's DBMN settings, one instance for every screen and service. Signed in, the
 * settings that follow the user come from the account (AccountSettings); the rest, and all of
 * them signed out, are VS Code's own settings as before.
 *
 * A roaming setting edited in VS Code's own Settings while signed in goes to the account too, so
 * VS Code's settings UI keeps working. The account never writes back into settings.json.
 */
import * as vscode from 'vscode';
import { ACCOUNT_SETTINGS, AccountSettings, type SettingsMap } from '../../services/settings/account-settings';
import { VsCodeConfiguration } from './vscode-configuration';

let shared: AccountSettings | undefined;

/** The settings every VS Code screen and service reads (and the Hub's Settings write). */
export function dbmnSettings(): AccountSettings {
    if (!shared) {
        const configuration = new VsCodeConfiguration();
        shared = new AccountSettings({
            get: (section, key, defaultValue) => configuration.get(section, key, defaultValue),
            update: async (section, key, value) => {
                await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
            }
        });
    }
    return shared;
}

/** The roaming settings this VS Code has set itself (user settings, not defaults). */
export function ownRoamingSettings(): SettingsMap {
    const own: SettingsMap = {};
    for (const name of ACCOUNT_SETTINGS) {
        const dot = name.lastIndexOf('.');
        const value = vscode.workspace.getConfiguration(name.slice(0, dot)).inspect(name.slice(dot + 1))?.globalValue;
        if (value !== undefined) own[name] = value;
    }
    return own;
}

/** Signed in: a roaming setting changed in VS Code's Settings goes to the account. */
export function forwardSettingsEdits(log: (message: string, error?: unknown) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(event => {
        const settings = dbmnSettings();
        if (!settings.connected) return;
        for (const name of ACCOUNT_SETTINGS) {
            if (!event.affectsConfiguration(name)) continue;
            const dot = name.lastIndexOf('.');
            const value = vscode.workspace.getConfiguration(name.slice(0, dot)).inspect(name.slice(dot + 1))?.globalValue;
            settings.update(name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1), value)
                .catch(error => log(`[Settings] could not save ${name} to your account`, error));
        }
    });
}
