// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #342: VS Code on the user's API Catalogue in their DBMN account (Supabase), the same one the
 * web app uses: endpoints, environments and Systems. VS Code keeps only secrets on the device
 * (the vault, SecretStorage), plus per-device state such as the active environment.
 *
 * - First sign-in to an account on a device with a catalogue of its own: the user is asked
 *   whether to save it to their account (the wording: catalogue-location.ts).
 *   "Save to my account…": they pick a folder for a copy, an ordinary Export without credentials
 *   that Import restores, and then it is copied, once: items the account already has (by id, or
 *   the same item made twice) keep the account's copy; secrets come into the vault. The move is
 *   recorded per device, so the web app knows the account has signed in from VS Code.
 * - "Keep on this computer" is remembered (per device): nothing goes to the account, VS Code
 *   stays on the device's catalogue and does not ask again. Settings and Home offer "Save to my
 *   account…" from then on. The question is asked once: closing it, or picking no folder for the
 *   copy, counts as "Keep on this computer" (0.3.2: nothing of 0.3.x's account storage is forced
 *   on a user who did not say yes).
 * - This VS Code's settings (#281) and Console views (#365) go to the account only along with
 *   the catalogue; kept on this computer, they stay VS Code's own.
 * - The device's own catalogue is never changed or deleted: older versions of the extension
 *   (the marketplace one, a main-branch build) keep using it. Once moved, this version ignores
 *   it, even when more is added to it later.
 * - Signed in: the managers work on the account's catalogue; changes made elsewhere (the web
 *   app, another VS Code) arrive by Realtime and reload. Everything read or written is also kept
 *   in this computer's copy of that account's catalogue (#427, account-copy.ts).
 * - Signed out, once moved: like going offline (#427). The managers work on the copy of the
 *   account last signed in, editable, and what changed goes to that account at its next sign-in,
 *   before anything is loaded. Settings → Endpoints offers "Remove from this computer".
 *   With no copy (moved before #427, or removed), the catalogue is hidden: empty, keeps nothing.
 * - A move that fails (the copy included) leaves the device's catalogue where it is and tries
 *   again next sign-in.
 */
import * as vscode from 'vscode';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CatalogueState, CONSOLE_VIEWS_KEY, conflictMessage, secretKey } from '../../services/catalogue/catalogue-state';
import {
    catalogueStorageInfo, KEPT_ON_DEVICE_MESSAGE, offlineCatalogueStorageInfo, removeCopyPrompt, SAVE_CATALOGUE_PROMPT, savingCatalogueStorageInfo, type CatalogueStorageInfo
} from '../../services/catalogue/catalogue-location';
import { followCatalogueChanges, type LiveCatalogue } from '../../services/catalogue/catalogue-live';
import {
    addDeviceCatalogue, describeCatalogueCount, deviceCatalogueMissing, deviceEnvironmentsForVault, deviceHasCatalogue
} from '../../services/catalogue/catalogue-upload';
import { SupabaseCatalogStore } from '../../platform/supabase/supabase-catalog-store';
import {
    AccountCopy, MirroredCatalogStore, OfflineCatalogStore, offlineChangesMessage, prefixedStore, sendOfflineChanges
} from '../../services/catalogue/account-copy';
import { SupabaseSettingsStore } from '../../platform/supabase/supabase-settings-store';
import { RUN_COUNTERS_LOCAL_MESSAGE, RUN_COUNTERS_OFFLINE_MESSAGE } from '../../services/catalogue/run-counters';
import { dbmnSettings, ownRoamingSettings } from './vscode-settings';
import { withoutDeviceCatalogue, type SwitchableStoreContext } from '../../services/catalogue/switchable-store-context';
import { getBackend } from '../../services/dbmn-backend/backend-config';
import type { IDbmnAuthService } from '../../services/dbmn-auth/dbmn-auth.interface';
import type { EnvironmentConfig, EnvironmentManager } from '../../environmentManager';
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { SystemManager } from '../../systemManager';
import { ImportExportService } from '../../services/import-export/import-export.service';
import { VsCodeFolderFileSink } from '../../services/io/vscode-folder-file-sink';
import { hostChoice } from '../../services/ui/dbmn-prompts';
import type { IKeyValueStore } from '../interfaces/key-value-store.interface';
import { getToast } from '../../services/notifications/get-toast';
import { recordWorkspace } from '../../platform/supabase/account-workspaces';
import type { WorkspaceMarker } from '../../services/workspace/workspace-layout';

export interface CatalogueManagers { endpoints: APIEndpointManager; environments: EnvironmentManager; systems: SystemManager }

/** 2026-10-08: the user's own date, for the copy's name. */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Device state (per account): when this device's catalogue moved to that account. */
const MOVE_RECORDED_KEY = 'movedToAccountAt';
/** Device state (per account): when this VS Code's own settings went to that account (#281). */
const SETTINGS_ADOPTED_KEY = 'settingsAdoptedAt';
/** This device's catalogue has moved to an account: signed out, it stays hidden. */
const DEVICE_MOVED_KEY = (profile: string) => `catalogue:${profile}:deviceMoved`;
/** The user chose "Keep on this computer": the catalogue stays on the device, and nobody asks again. */
const KEEP_ON_DEVICE_KEY = (profile: string) => `catalogue:${profile}:keepOnDevice`;
/** #427: whose catalogue the copy signed out is (the account last connected). */
const LAST_ACCOUNT_KEY = (profile: string) => `catalogue:${profile}:lastAccount`;

export class VsCodeCatalogue implements vscode.Disposable {
    private connected?: { userId: string; store: SupabaseCatalogStore; state: CatalogueState; live?: LiveCatalogue };
    /** Signed in as this user with the catalogue kept on this computer (their choice). */
    private keptFor?: string;
    /** Signed in as this user, on the device's catalogue for any reason (kept, or not decided yet). */
    private signedInOnDevice?: string;
    /** "Save to my account…" from Settings or Home: the question is answered, go to the copy. */
    private decidedToSave = false;
    /** While the device's catalogue goes to the account: what is going ("67 endpoints and 8 environments"). */
    private saving?: string;
    /** #427: signed out, working on this computer's copy of that account's catalogue. */
    private offline?: { userId: string; state: CatalogueState; copy: AccountCopy };
    private pending: Promise<void> = Promise.resolve();
    private readonly subscriptions: Array<{ dispose(): void }> = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: SwitchableStoreContext,
        private readonly managers: CatalogueManagers,
        private readonly auth: IDbmnAuthService,
        private readonly log: (message: string, error?: unknown) => void
    ) {}

    start(): void {
        this.pending = this.useDeviceStore();
        this.subscriptions.push(this.auth.onAuthStateChanged(() => this.follow()));
        this.follow();
    }

    /**
     * Signed out: the device's store. Once moved to an account, the copy of the account last
     * signed in (#427), or the catalogue hidden when there is no copy.
     */
    private async useDeviceStore(): Promise<void> {
        this.offline = undefined;
        const profile = getBackend().profile;
        if (!this.context.globalState.get<string>(DEVICE_MOVED_KEY(profile))) {
            this.store.switchToLocal();
            return;
        }
        const userId = this.context.globalState.get<string>(LAST_ACCOUNT_KEY(profile));
        const copy = userId ? this.copyFor(userId) : undefined;
        if (userId && copy?.exists) {
            const state = new CatalogueState(new OfflineCatalogStore(copy), this.deviceStore(`catalogue:${profile}:${userId}:`), this.context.secrets);
            state.onCountersLocal = () => getToast()?.warn(RUN_COUNTERS_OFFLINE_MESSAGE);
            try {
                await state.load();
                this.offline = { userId, state, copy };
                this.store.switchTo(state);
                this.log(`[Catalogue] signed out: working on this computer's copy of ${userId}'s catalogue`);
                return;
            } catch (error) {
                this.log("[Catalogue] could not open this computer's copy of the account's catalogue", error);
            }
        }
        this.store.switchTo(withoutDeviceCatalogue(this.store.localStore));
    }

    /** #427: this computer's copy of one account's catalogue. */
    private copyFor(userId: string): AccountCopy {
        return new AccountCopy(prefixedStore(this.context.globalState, `catalogue:${getBackend().profile}:${userId}:copy:`));
    }

    /**
     * #427: what changed here while signed out, to the account, before anything is loaded over
     * the copy. Edits still being written land first.
     */
    private async sendOffline(userId: string, remote: SupabaseCatalogStore, copy: AccountCopy): Promise<void> {
        if (this.offline?.userId === userId) await this.offline.state.settled();
        if (copy.pending().length === 0) return;
        const result = await sendOfflineChanges(remote, copy, {
            onCopied: async (kind, fromId, toId) => {
                if (kind !== 'environments') return;
                const secrets = await this.context.secrets.get(secretKey(fromId));
                if (secrets) await this.context.secrets.store(secretKey(toId), secrets);
            }
        });
        const message = offlineChangesMessage(result);
        if (message) getToast()?.info(message, { persistent: result.conflicts.length > 0 });
        this.log(`[Catalogue] sent ${result.sent} changes made while signed out (${result.conflicts.length} changed in both places)`);
    }

    /** Bring the store in line with who is signed in (one change at a time). */
    private follow(): void {
        this.pending = this.pending.then(async () => {
            const session = this.auth.getSession();
            const userId = this.auth.isAuthenticated() && session ? session.userId : undefined;
            if (userId === (this.connected?.userId ?? this.keptFor)) return;
            await this.disconnect();
            if (userId) await this.connect(userId);
        }).catch(error => this.log('[Catalogue] could not follow the sign-in', error));
    }

    private async connect(userId: string): Promise<void> {
        const accessToken = async () => {
            const result = await this.auth.ensureValidSession();
            return result.status === 'success' ? result.session.accessToken : null;
        };
        const backend = getBackend();
        const client = createClient(backend.apiUrl, backend.anonKey, { accessToken });
        const device = this.deviceStore(`catalogue:${backend.profile}:${userId}:`);
        this.signedInOnDevice = userId;
        // Their choice, made earlier: the device's catalogue, and nothing of it to the account
        if (this.keepsOnDevice && !this.decidedToSave && !device.get<string>(MOVE_RECORDED_KEY)) {
            this.keepOnDevice(userId);
            return;
        }
        const store = new SupabaseCatalogStore(client, { accessToken });
        const copy = this.copyFor(userId);
        const state = new CatalogueState(new MirroredCatalogStore(store, copy), device, this.context.secrets);
        state.onConflict = conflict => getToast()?.warn(conflictMessage(conflict));
        state.onCountersLocal = () => getToast()?.warn(RUN_COUNTERS_LOCAL_MESSAGE);
        try {
            if (device.get<string>(MOVE_RECORDED_KEY)) await this.sendOffline(userId, store, copy);
            await state.load();
            const moved = await this.moveDeviceCatalogue(userId, store, state, device);
            if (moved !== 'moved') {
                await store.dispose().catch(() => undefined);
                if (moved === 'kept' || this.keepsOnDevice) {
                    this.keepOnDevice(userId);
                } else {
                    // "Save to my account…" from Settings or Home, and then no folder for the copy
                    this.log('[Catalogue] nothing saved: this device\'s catalogue stays where it is');
                    this.notify();
                }
                return;
            }
        } catch (error) {
            this.log('[Catalogue] could not load the account\'s catalogue, or move this device\'s to it', error);
            getToast()?.warn('Could not save your endpoints and environments to your DBMN account. Nothing has changed; they stay on this computer, and signing in again tries again.');
            await store.dispose().catch(() => undefined);
            this.notify();
            return;
        }

        await this.connectSettings(client, accessToken, device);
        await this.adoptDeviceViews(state);
        void this.recordWorkspace(client, userId);
        this.signedInOnDevice = undefined;
        this.offline = undefined;
        await this.context.globalState.update(LAST_ACCOUNT_KEY(backend.profile), userId);
        this.connected = { userId, store, state };
        this.store.switchTo(state);
        this.notify();
        this.log(`[Catalogue] using the account's catalogue for ${userId}`);
        this.connected.live = followCatalogueChanges(store, state, {
            onReloaded: () => { if (this.connected?.state === state) this.notify(); },
            log: (message, error) => this.log(message, error)
        });
        await this.connected.live.ready;
    }

    private get keepsOnDevice(): boolean {
        return !!this.context.globalState.get<string>(KEEP_ON_DEVICE_KEY(getBackend().profile));
    }

    /** Signed in, with the catalogue on this computer by the user's choice. */
    private keepOnDevice(userId: string): void {
        this.offline = undefined;
        this.keptFor = userId;
        this.decidedToSave = false;
        this.store.switchToLocal();
        this.notify();
        this.log(`[Catalogue] kept on this computer for ${userId}: nothing of it goes to the account`);
    }

    /** Where the catalogue of whoever is signed in lives, in words for Settings and Home; undefined signed out. */
    storage(): CatalogueStorageInfo | undefined {
        if (this.connected) return catalogueStorageInfo('account');
        if (this.saving) return savingCatalogueStorageInfo(this.saving);
        if (this.signedInOnDevice) return catalogueStorageInfo('device');
        return this.offline ? offlineCatalogueStorageInfo(this.offline.copy.pending().length) : undefined;
    }

    /**
     * #427, Settings → Endpoints, signed out: the account's catalogue off this computer (a
     * shared machine), secrets entered here included. Asked first; it stays in the account.
     */
    async removeFromDevice(): Promise<void> {
        const offline = this.offline;
        if (!offline || this.connected) return;
        if (await hostChoice(removeCopyPrompt(offline.copy.pending().length)) !== 'remove') return;
        this.pending = this.pending.then(async () => {
            if (this.offline !== offline) return;
            await offline.state.settled();
            for (const id of offline.copy.environmentIds()) await this.context.secrets.delete(secretKey(id));
            await offline.copy.clear();
            await this.context.globalState.update(LAST_ACCOUNT_KEY(getBackend().profile), undefined);
            await this.useDeviceStore();
            this.notify();
            getToast()?.info('Your endpoints and environments are removed from this computer. They are still in your DBMN account.');
            this.log(`[Catalogue] removed this computer's copy of ${offline.userId}'s catalogue`);
        }).catch(error => this.log("[Catalogue] could not remove this computer's copy", error));
        await this.pending;
    }

    /**
     * Settings / Home "Save to my account…", for a catalogue that is on this computer: the
     * question is answered, so it goes straight to the copy and the move. Picking no folder
     * leaves everything as it was.
     */
    async saveToAccount(): Promise<void> {
        if (this.connected || !this.signedInOnDevice) return;
        this.decidedToSave = true;
        this.keptFor = undefined;
        this.follow();
        await this.pending;
        this.decidedToSave = false;
    }

    /** The one-time move of this device's own catalogue to the account (see the header). */
    private async moveDeviceCatalogue(userId: string, store: SupabaseCatalogStore, state: CatalogueState, device: Pick<IKeyValueStore, 'get' | 'update'>): Promise<'moved' | 'postponed' | 'kept'> {
        const local = this.store.localStore;
        if (device.get<string>(MOVE_RECORDED_KEY)) {   // once: what's on the device now is ignored
            if (!this.context.globalState.get<string>(DEVICE_MOVED_KEY(getBackend().profile))) await this.markMoved(device);
            return 'moved';
        }
        if (!deviceHasCatalogue(local)) {
            await store.recordMigration(vscode.env.machineId, { endpoints: 0, environments: 0 });
            await this.markMoved(device);
            return 'moved';
        }

        const copy = await this.saveCopy();
        if (copy === 'keep' || (!copy && !this.decidedToSave)) {
            // The question is asked once: closed, or "Save to my account…" with no folder picked,
            // is "Keep on this computer" too. Settings and Home save it any time.
            await this.context.globalState.update(KEEP_ON_DEVICE_KEY(getBackend().profile), new Date().toISOString());
            getToast()?.info(KEPT_ON_DEVICE_MESSAGE, { persistent: true });
            return 'kept';
        }
        if (!copy) return 'postponed';

        const moving = deviceCatalogueMissing(local, state);
        const forVault = deviceEnvironmentsForVault<EnvironmentConfig>(local, state);
        if (moving.ids.length) {
            // Said at once, the copy and the move: until the end it otherwise looked like nothing happened
            this.saving = describeCatalogueCount(moving.endpoints, moving.environments);
            getToast()?.info(`The copy is saved at ${copy}. Saving ${this.saving} to your DBMN account…`);
            this.notify();
        }
        try {
            await addDeviceCatalogue(local, state);
            await state.adoptSecrets(forVault);
            await store.recordMigration(vscode.env.machineId, { endpoints: moving.endpoints, environments: moving.environments });
            await this.markMoved(device);
        } finally {
            this.saving = undefined;
        }
        const moved = moving.ids.length
            ? `Saved ${describeCatalogueCount(moving.endpoints, moving.environments)} to your DBMN account.`
            : 'Your endpoints and environments were already in your DBMN account.';
        getToast()?.info(`${moved} A copy is at ${copy}.`, { persistent: true });
        this.log(`[Catalogue] moved this device's catalogue to the account for ${userId}: ${moving.endpoints} endpoints, ${moving.environments} environments; copy at ${copy}`);
        return 'moved';
    }

    /**
     * #281: the account's settings while signed in; this VS Code's own values for settings the
     * account has none for go up once. Never blocks sign-in: on failure VS Code's settings stay.
     */
    private async connectSettings(client: SupabaseClient, accessToken: () => Promise<string | null>, device: Pick<IKeyValueStore, 'get' | 'update'>): Promise<void> {
        const settings = dbmnSettings();
        try {
            await settings.connect(new SupabaseSettingsStore(client, { accessToken }), (message, error) => this.log(message, error));
            if (!device.get<string>(SETTINGS_ADOPTED_KEY)) {
                const added = await settings.adopt(ownRoamingSettings());
                await device.update(SETTINGS_ADOPTED_KEY, new Date().toISOString());
                if (added) this.log(`[Settings] moved ${added} of this VS Code's settings to the account`);
            }
        } catch (error) {
            this.log("[Settings] could not use the account's settings; VS Code's own stay in use", error);
            await settings.disconnect();
        }
    }

    /** #365: this device's Console views (globalState) into the account, once. Never blocks sign-in. */
    private async adoptDeviceViews(state: CatalogueState): Promise<void> {
        try {
            const added = await state.adoptDeviceViews(this.context.globalState.get(CONSOLE_VIEWS_KEY));
            if (added) this.log(`[Catalogue] moved this device's Console views to the account: ${added} view scopes`);
        } catch (error) {
            this.log("[Catalogue] could not move this device's Console views to the account; next sign-in tries again", error);
        }
    }

    private async markMoved(device: Pick<IKeyValueStore, 'get' | 'update'>): Promise<void> {
        const now = new Date().toISOString();
        await device.update(MOVE_RECORDED_KEY, now);
        await this.context.globalState.update(DEVICE_MOVED_KEY(getBackend().profile), now);
        await this.context.globalState.update(KEEP_ON_DEVICE_KEY(getBackend().profile), undefined);
    }

    /**
     * Ask where the catalogue should live (unless that is already answered), then save a copy
     * (an Export without credentials) in a folder the user chooses. The path of the copy;
     * 'keep' for "Keep on this computer" or a closed question; undefined when no folder was picked.
     */
    private async saveCopy(): Promise<string | 'keep' | undefined> {
        if (!this.decidedToSave) {
            const choice = await hostChoice(SAVE_CATALOGUE_PROMPT);
            if (choice !== 'save') return 'keep';
        }
        const workspacePath = this.context.globalState.get<string>('dbmn.workspacePath');
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Save copy here',
            title: 'Where to save a copy of your endpoints and environments',
            defaultUri: workspacePath ? vscode.Uri.file(workspacePath) : undefined
        });
        if (!picked?.[0]) return undefined;

        const { endpoints, environments, systems } = this.managers;
        const exporter = new ImportExportService(endpoints, environments, null, this.context, undefined, new VsCodeFolderFileSink(picked[0]), systems);
        const result = await exporter.exportToZip({
            endpoints: (await endpoints.getAllEndpoints()).map(e => e.id),
            environments: (await environments.getAllEnvironments()).filter(e => e.baseUrl).map(e => e.id),
            includeConsoleSettings: false,
            includeCredentials: false,
            filename: `dbmn-catalogue-${localDate(new Date())}`
        });
        if (!result.success || !result.filePath) {
            throw new Error(`Saving the copy failed: ${result.error ?? 'unknown error'}`);
        }
        return result.filePath;
    }

    /** #344: which workspace this device uses, on the account, for the web app to suggest and check. */
    private async recordWorkspace(client: SupabaseClient, userId: string): Promise<void> {
        const workspace = (globalThis as Record<string, unknown>).dobermannWorkspaceManager as
            { getWorkspacePath?(): string | null; getWorkspaceMarker?(): WorkspaceMarker | undefined } | undefined;
        const path = workspace?.getWorkspacePath?.();
        const marker = workspace?.getWorkspaceMarker?.();
        if (!path || !marker) return;
        try {
            await recordWorkspace(client, { workspaceId: marker.id, deviceId: vscode.env.machineId, name: marker.name, path });
            this.log(`[Catalogue] recorded workspace ${marker.name} (${path}) for ${userId}`);
        } catch (error) {
            this.log('[Catalogue] could not record the workspace on the account', error);
        }
    }

    private async disconnect(): Promise<void> {
        await dbmnSettings().disconnect();
        const connected = this.connected;
        this.connected = undefined;
        if (this.signedInOnDevice) {
            // Signed out (or about to save to the account): the Hub's Settings follow
            this.signedInOnDevice = undefined;
            this.keptFor = undefined;
            if (!connected) this.notify();
        }
        if (!connected) return;
        connected.live?.dispose();
        await connected.state.settled().catch(() => undefined);              // #427: into the copy first
        await connected.state.runCounters.flush().catch(() => undefined);   // #366: unused values back
        await connected.store.dispose().catch(() => undefined);
        await this.useDeviceStore();
        this.notify();
        this.log("[Catalogue] signed out: using this device's store");
    }

    private notify(): void {
        this.managers.endpoints.notifyChanged();
        this.managers.environments.notifyChanged();
        this.managers.systems.notifyChanged();
    }

    /** This device's state for the account's catalogue, per backend and user, in globalState. */
    private deviceStore(prefix: string): Pick<IKeyValueStore, 'get' | 'update'> {
        const state = this.context.globalState;
        return {
            get: ((key: string, defaultValue?: unknown) => state.get(prefix + key, defaultValue)) as IKeyValueStore['get'],
            update: (key: string, value: unknown) => state.update(prefix + key, value)
        };
    }

    dispose(): void {
        for (const s of this.subscriptions) s.dispose();
        void this.disconnect();
    }
}
