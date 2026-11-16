// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The catalogue as the managers see it (#343, #342): a StoreContext that APIEndpointManager,
 * EnvironmentManager and SystemManager persist through, for both hosts. The web app always uses
 * it; VS Code uses it unless "keep catalogue local only" is on (then it passes globalState).
 *
 * - The catalogue keys ('apiEndpoints', 'environments', 'apiSystems') are kept in the user's
 *   catalogue (SupabaseCatalogStore, #341): each write saves the items that changed, in the safe
 *   form (#339), and deletes the ones that went. Creating names version 0, so a new item can
 *   never overwrite one that already has its id; an update names the version it read.
 * - What the safe form keeps off the catalogue stays on this device:
 *     device state  which environment is active, its organisation, last used; run counters
 *                   from before #366 (the floor of the account's, runCounters)
 *     the vault     secrets: OAuth client secret, service-account key, session tokens, values of
 *                   headers and variables marked secret (#362: never plain device state)
 *   Both are merged back over the catalogue on load.
 * - Console views (#365, key 'consoleViewsRegistry'): one catalogue item per view scope, so they
 *   follow the user too. A device's own views come in once (adoptDeviceViews).
 * - Every other key (Recent, Hub preferences) is device state; `secrets` is the vault.
 *
 * Ports: `device` (VS Code globalState; the browser's localStorage), `vault` (VS Code
 * SecretStorage; the browser per #344's policy), `catalogue` (the user's CatalogStore).
 */
import type { APIEndpointCollection, APIEndpointConfig } from '../../apiConfigManager';
import type { EnvironmentCollection, EnvironmentConfig } from '../../environmentManager';
import type { SystemCollection, SystemConfig } from '../../data-loading/system-schema';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import type { ISecretStore } from '../../platform/interfaces/secret-store.interface';
import type { StoreContext } from '../../platform/interfaces/store-context.interface';
import { CatalogConflictError, type CatalogChange, type CatalogCollection, type CatalogStore } from './catalog-store.interface';
import { environmentSecrets, EnvironmentSecrets, toCatalogueEndpoint, toCatalogueEnvironment, withEnvironmentSecrets } from './catalogue-safe-form';
import { DEVICE_LOCAL_ENVIRONMENT_FIELDS, type CatalogueConsoleViews, type CatalogueKind } from './catalogue.types';
import { isV2ConsoleViewsRegistry, migrateConsoleViewsRegistry, getEndpointViewScopeKey, type ConsoleViewsRegistryV2 } from '../console/view-scope-key';
import { AccountRunCounters } from './run-counters';

type Item = { id: string };
type Kind = 'endpoints' | 'environments' | 'systems';

/** The managers' storage keys, and where each keeps its list. */
export const CATALOGUE_KEYS: Record<string, { kind: Kind; list: 'endpoints' | 'environments' | 'systems' }> = {
    apiEndpoints: { kind: 'endpoints', list: 'endpoints' },
    environments: { kind: 'environments', list: 'environments' },
    apiSystems: { kind: 'systems', list: 'systems' }
};

/** #365: the Console's view registry (ConsoleController), kept in the catalogue's `views`. */
export const CONSOLE_VIEWS_KEY = 'consoleViewsRegistry';
/** Device state: when this device's own Console views came into the account (once). */
const VIEWS_ADOPTED_KEY = 'consoleViews:adoptedAt';
/** Device state: this device's copy of each run counter, for when the account can't be reached (#366). */
const LOCAL_COUNTERS_KEY = 'runCounters:local';
type LocalCopies = Record<string, { last: number; ahead: boolean }>;
/** Device state: the run counters whose floor has gone to the account (#366). */
const SEEDED_KEY = 'runCounters:seeded';
const ENDPOINT_DEVICE_FIELDS = ['sequenceCounter', 'arraySequenceCounters'] as const;
/** Where an environment's secrets are kept in the vault. */
export const secretKey = (environmentId: string) => `catalogue-secrets:environment:${environmentId}`;
/**
 * The same JSON, whatever order the keys are in. #454: the account hands items back in Postgres
 * jsonb key order, so comparing the text found every environment changed, and each switch
 * re-saved them all (slow, and it raised every version until two laptops made "(copy)"s).
 */
const sortedKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortedKeys)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys((value as Record<string, unknown>)[key])]))
        : value;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));

/** The fields of an item that are this device's alone (never secrets: those are the vault's). */
function deviceFields(kind: Kind, item: Record<string, unknown>): Record<string, unknown> | undefined {
    const fields: readonly string[] = kind === 'endpoints' ? ENDPOINT_DEVICE_FIELDS : kind === 'environments' ? DEVICE_LOCAL_ENVIRONMENT_FIELDS : [];
    const picked: Record<string, unknown> = {};
    for (const field of fields) if (item[field] !== undefined) picked[field] = item[field];
    return Object.keys(picked).length ? picked : undefined;
}

function safeForm(kind: Kind, item: Item): Item {
    if (kind === 'endpoints') return toCatalogueEndpoint(item as APIEndpointConfig) as Item;
    if (kind === 'environments') return toCatalogueEnvironment(item as EnvironmentConfig) as unknown as Item;
    return item;
}

export class CatalogueState implements StoreContext {
    /** The managers' collections, as they last wrote them (or as loaded). */
    private readonly values = new Map<string, unknown>();
    /** Catalogue version per `kind:id`, for versioned writes. */
    private readonly versions = new Map<string, number>();
    /** What the vault holds per environment, so unchanged secrets aren't rewritten. */
    private readonly vaulted = new Map<string, string>();
    /** Writes in order: a manager's second save must not overtake its first. */
    private queue: Promise<unknown> = Promise.resolve();
    /** The items this device is saving or deleting right now (`kind:id`), see isOwnWrite. */
    private readonly writing = new Set<string>();

    readonly globalState: StoreContext['globalState'] = {
        get: <T>(key: string, defaultValue?: T): T | undefined => {
            if (CATALOGUE_KEYS[key] || key === CONSOLE_VIEWS_KEY) {
                const value = this.values.get(key);
                return (value === undefined ? defaultValue : structuredClone(value)) as T | undefined;
            }
            return (this.device.get<T>(key) ?? defaultValue) as T | undefined;
        },
        update: (key: string, value: unknown): Promise<void> => {
            if (!CATALOGUE_KEYS[key] && key !== CONSOLE_VIEWS_KEY) return Promise.resolve(this.device.update(key, value));
            const previous = this.values.get(key) as Record<string, unknown> | undefined;
            this.values.set(key, structuredClone(value));
            const write = this.queue.then(async () => {
                if (key === CONSOLE_VIEWS_KEY) {
                    await this.saveItems('views', viewItems(previous), viewItems(value));
                    return;
                }
                await this.saveDevice(key, value as Record<string, unknown>);
                await this.sync(key, previous, value as Record<string, unknown>);
            });
            this.queue = write.catch(() => undefined);
            return write;
        }
    } as StoreContext['globalState'];

    readonly secrets: ISecretStore;

    /** #366: run counters in the user's catalogue; this device's old counters are their floor. */
    readonly runCounters: AccountRunCounters;

    /**
     * The account's counters couldn't be reached, so sequence numbers are coming from this
     * device's copy: the host warns (RUN_COUNTERS_LOCAL_MESSAGE).
     */
    onCountersLocal?: () => void;

    /**
     * An edit saved over a change made elsewhere since it was read (the web app, another VS Code):
     * the second save wins, and the host warns (conflictMessage). Deliberately simple: no merge,
     * no lock.
     */
    onConflict?: (conflict: CatalogueConflict) => void;

    constructor(
        private readonly catalogue: CatalogStore,
        private readonly device: Pick<IKeyValueStore, 'get' | 'update'>,
        vault: ISecretStore
    ) {
        this.secrets = vault;
        this.runCounters = new AccountRunCounters(catalogue, {
            floor: (endpointId, arrayPath) => this.deviceCounter(endpointId, arrayPath),
            seeded: {
                has: key => Boolean(this.device.get<Record<string, true>>(SEEDED_KEY)?.[key]),
                add: key => Promise.resolve(this.device.update(SEEDED_KEY, { ...(this.device.get<Record<string, true>>(SEEDED_KEY) ?? {}), [key]: true }))
            },
            local: {
                get: key => this.device.get<LocalCopies>(LOCAL_COUNTERS_KEY)?.[key] ?? { last: 0, ahead: false },
                set: (key, value) => Promise.resolve(this.device.update(LOCAL_COUNTERS_KEY, { ...(this.device.get<LocalCopies>(LOCAL_COUNTERS_KEY) ?? {}), [key]: value })),
                clearArrays: endpointId => {
                    const kept = Object.entries(this.device.get<LocalCopies>(LOCAL_COUNTERS_KEY) ?? {})
                        .filter(([key]) => !key.startsWith(`${endpointId}\u0000`) || key === `${endpointId}\u0000`);
                    return Promise.resolve(this.device.update(LOCAL_COUNTERS_KEY, Object.fromEntries(kept)));
                }
            },
            onLocal: () => this.onCountersLocal?.()
        });
    }

    /** The counter this device kept for an endpoint before #366 (merged onto the loaded item). */
    private deviceCounter(endpointId: string, arrayPath?: string): number {
        const collection = this.values.get('apiEndpoints') as APIEndpointCollection | undefined;
        const endpoint = collection?.endpoints.find(e => e.id === endpointId);
        if (!endpoint) return 0;
        return (arrayPath === undefined ? endpoint.sequenceCounter : endpoint.arraySequenceCounters?.[arrayPath]) ?? 0;
    }

    /**
     * Reload after a change made elsewhere (Realtime), once this device's own writes have landed:
     * a reload in the middle of a save would put the old item back over the one being saved.
     */
    async reload(): Promise<void> {
        await this.queue;
        await this.load();
    }

    /**
     * A change the store announced while this device was writing that very item: our own save,
     * already in memory. Reloading the whole catalogue for it (every endpoint, environment and
     * System from the account, then every screen) is what made a header pick slow (2026-11-13).
     */
    isOwnWrite(change: Pick<CatalogChange, 'kind' | 'id'>): boolean {
        return this.writing.has(`${change.kind}:${change.id}`);
    }

    /** This device's own writes have landed (#427: before the copy goes to the account). */
    async settled(): Promise<void> {
        await this.queue;
    }

    /**
     * Moving a device's catalogue to the account (#342): the secrets of the device's environments
     * the account already had (so they weren't added) still come into the vault, unless the vault
     * already has that environment's. Then reload, so they're on the loaded items.
     */
    async adoptSecrets(environments: EnvironmentConfig[]): Promise<void> {
        for (const environment of environments) {
            if (await this.secrets.get(secretKey(environment.id))) continue;
            const secrets = environmentSecrets(environment);
            if (secrets) await this.secrets.store(secretKey(environment.id), JSON.stringify(secrets));
        }
        await this.reload();
    }

    /**
     * #365: this device's own Console views into the account, once: the scopes the account
     * doesn't have yet. A scope it has keeps the account's views. VS Code passes the registry
     * from its globalState; the web app's is on this state's device (load finds it). How many
     * scopes came in.
     */
    async adoptDeviceViews(registry: unknown): Promise<number> {
        if (this.device.get<string>(VIEWS_ADOPTED_KEY)) return 0;
        const device = await this.asViewRegistry(registry);
        if (Object.keys(device.scopes).length === 0) return 0;
        const current = this.globalState.get<ConsoleViewsRegistryV2>(CONSOLE_VIEWS_KEY)!;
        const missing = Object.entries(device.scopes).filter(([scope, views]) => !current.scopes[scope] && views && typeof views === 'object');
        if (missing.length) {
            await this.globalState.update(CONSOLE_VIEWS_KEY, { ...current, scopes: { ...current.scopes, ...Object.fromEntries(missing) } });
        }
        await this.device.update(VIEWS_ADOPTED_KEY, new Date().toISOString());
        return missing.length;
    }

    /** A device registry in the current (v2, scope-keyed) form; a pre-#237 one is migrated. */
    private async asViewRegistry(raw: unknown): Promise<ConsoleViewsRegistryV2> {
        if (isV2ConsoleViewsRegistry(raw)) return raw;
        if (!raw || typeof raw !== 'object') return { schemaVersion: 2, scopes: {} };
        const endpoints = (this.values.get('apiEndpoints') as APIEndpointCollection | undefined)?.endpoints ?? [];
        const { registry } = await migrateConsoleViewsRegistry(raw as Record<string, unknown>, async endpointId => {
            const endpoint = endpoints.find(e => e.id === endpointId);
            return endpoint ? getEndpointViewScopeKey(endpoint.method, endpoint.path) : `orphan:${endpointId}`;
        });
        return registry;
    }

    /** Nothing in the user's catalogue yet (a new account, or one that never uploaded). */
    get isEmpty(): boolean {
        return Object.entries(CATALOGUE_KEYS).every(([key, { list }]) =>
            ((this.values.get(key) as Record<string, unknown[]> | undefined)?.[list] ?? []).length === 0);
    }

    /** Load the user's catalogue, with this device's state and secrets merged back on. */
    async load(): Promise<void> {
        const [endpoints, environments, systems, views] = await Promise.all([
            this.catalogue.endpoints.list(),
            this.catalogue.environments.list(),
            this.catalogue.systems.list(),
            this.catalogue.views.list()
        ]);
        const loaded: Record<Kind, Item[]> = { endpoints: [], environments: [], systems: [] };
        for (const [kind, rows] of [['endpoints', endpoints], ['environments', environments], ['systems', systems]] as const) {
            const device = this.device.get<Record<string, Record<string, unknown>>>(`device:${kind}`) ?? {};
            for (const row of rows) {
                this.versions.set(`${kind}:${row.item.id}`, row.version);
                const local = device[row.item.id];
                let item = { ...(row.item as Item), ...(local ? deviceFields(kind, local) : {}) } as Item;
                if (kind === 'environments') item = await this.withSecrets(item as unknown as EnvironmentConfig, local) as unknown as Item;
                loaded[kind].push(item);
            }
        }
        const activeEnvironmentId = this.device.get<string>('activeEnvironmentId');
        this.values.set('apiEndpoints', { endpoints: loaded.endpoints as APIEndpointConfig[], folders: [], version: '1.1.0' } satisfies APIEndpointCollection);
        this.values.set('environments', {
            environments: loaded.environments as EnvironmentConfig[],
            folders: [],
            activeEnvironmentId: loaded.environments.some(e => e.id === activeEnvironmentId) ? activeEnvironmentId : undefined,
            version: '1.2.0'
        } satisfies EnvironmentCollection);
        this.values.set('apiSystems', { systems: loaded.systems as SystemConfig[], version: '1.0.0' } as SystemCollection);
        for (const row of views) this.versions.set(`views:${row.item.id}`, row.version);
        this.values.set(CONSOLE_VIEWS_KEY, {
            schemaVersion: 2,
            scopes: Object.fromEntries(views.map(row => [row.item.id, row.item.views]))
        } satisfies ConsoleViewsRegistryV2);
        await this.adoptDeviceViews(this.device.get(CONSOLE_VIEWS_KEY));   // the web app's own, once
    }

    /**
     * The environment with its secrets from the vault. A device copy from before #342 kept the
     * whole environment, secrets included, in plain device state: those move to the vault once.
     */
    private async withSecrets(environment: EnvironmentConfig, legacyDeviceCopy: Record<string, unknown> | undefined): Promise<EnvironmentConfig> {
        const raw = await this.secrets.get(secretKey(environment.id));
        let secrets = raw ? JSON.parse(raw) as EnvironmentSecrets : undefined;
        if (!secrets && legacyDeviceCopy) {
            secrets = environmentSecrets(legacyDeviceCopy as unknown as EnvironmentConfig);
            if (secrets) await this.secrets.store(secretKey(environment.id), JSON.stringify(secrets));
        }
        if (secrets) this.vaulted.set(environment.id, JSON.stringify(secrets));
        return withEnvironmentSecrets(environment, secrets);
    }

    /** This device's state for each item (never its secrets), and the secrets to the vault. */
    private async saveDevice(key: string, collection: Record<string, unknown>): Promise<void> {
        const { kind, list } = CATALOGUE_KEYS[key];
        const items = (collection[list] as Item[] | undefined) ?? [];
        const device: Record<string, Record<string, unknown>> = {};
        for (const item of items) {
            const fields = deviceFields(kind, item as unknown as Record<string, unknown>);
            if (fields) device[item.id] = fields;
        }
        await this.device.update(`device:${kind}`, device);
        if (key !== 'environments') return;
        await this.device.update('activeEnvironmentId', (collection as { activeEnvironmentId?: string }).activeEnvironmentId);
        const kept = new Set<string>();
        for (const environment of items as unknown as EnvironmentConfig[]) {
            kept.add(environment.id);
            const secrets = environmentSecrets(environment);
            const json = secrets ? JSON.stringify(secrets) : undefined;
            if (json === this.vaulted.get(environment.id)) continue;
            if (json) await this.secrets.store(secretKey(environment.id), json);
            else await this.secrets.delete(secretKey(environment.id));
            if (json) this.vaulted.set(environment.id, json); else this.vaulted.delete(environment.id);
        }
        for (const id of [...this.vaulted.keys()]) {
            if (kept.has(id)) continue;
            await this.secrets.delete(secretKey(id));     // the environment went: so do its secrets
            this.vaulted.delete(id);
        }
    }

    /** Save what changed between two versions of a collection; delete what went. */
    private async sync(key: string, before: Record<string, unknown> | undefined, after: Record<string, unknown>): Promise<void> {
        const { kind, list } = CATALOGUE_KEYS[key];
        const old = ((before?.[list] as Item[] | undefined) ?? []).map(item => safeForm(kind, item));
        const now = ((after[list] as Item[] | undefined) ?? []).map(item => safeForm(kind, item));
        await this.saveItems(kind, old, now);
    }

    /** Save the items that changed (versioned), delete the ones that went. */
    private async saveItems(kind: CatalogueKind, before: Item[], now: Item[]): Promise<void> {
        const store = this.catalogue[kind] as CatalogCollection<Item>;
        const old = new Map(before.map(item => [item.id, item]));
        for (const item of now) {
            if (old.has(item.id) && sameJson(old.get(item.id), item)) continue;
            const versionKey = `${kind}:${item.id}`;
            let saved;
            this.writing.add(versionKey);
            try {
                saved = await store.save(item, this.versions.get(versionKey) ?? 0);
            } catch (error) {
                if (!(error instanceof CatalogConflictError)) throw error;
                saved = await store.save(item);   // changed elsewhere: this save wins
                this.onConflict?.({ kind, name: nameOf(item), deleted: false });
            } finally {
                this.writing.delete(versionKey);
            }
            this.versions.set(versionKey, saved.version);
        }
        const kept = new Set(now.map(item => item.id));
        for (const id of old.keys()) {
            if (kept.has(id)) continue;
            this.writing.add(`${kind}:${id}`);
            try {
                await store.delete(id, this.versions.get(`${kind}:${id}`));
            } catch (error) {
                if (!(error instanceof CatalogConflictError)) throw error;
                await store.delete(id);   // changed elsewhere: deleted anyway
                this.onConflict?.({ kind, name: nameOf(old.get(id)!), deleted: true });
            } finally {
                this.writing.delete(`${kind}:${id}`);
            }
            this.versions.delete(`${kind}:${id}`);
        }
    }
}

/** A save or delete that went over a change made elsewhere (see CatalogueState.onConflict). */
export interface CatalogueConflict {
    kind: CatalogueKind;
    name: string;
    deleted: boolean;
}

const KIND_NOUN: Record<CatalogueKind, string> = { endpoints: 'endpoint', environments: 'environment', systems: 'System', views: 'Console views of' };

/** #365: a view registry as catalogue items, one per scope. */
function viewItems(registry: unknown): CatalogueConsoleViews[] {
    if (!isV2ConsoleViewsRegistry(registry)) return [];
    return Object.entries(registry.scopes)
        .filter(([, views]) => views && typeof views === 'object')
        .map(([id, views]) => ({ id, views: views as Record<string, unknown> }));
}

function nameOf(item: Item): string {
    return (item as { name?: string }).name || item.id;
}

/** The warning both hosts show for a conflict. */
export function conflictMessage(conflict: CatalogueConflict): string {
    const what = `The ${KIND_NOUN[conflict.kind]} "${conflict.name}"`;
    const [was, it] = conflict.kind === 'views' ? ['were', 'They have'] : ['was', 'It has'];
    return conflict.deleted
        ? `${what} ${was} changed somewhere else (the web app or another VS Code) since you opened it. ${it} been deleted anyway.`
        : `${what} ${was} changed somewhere else (the web app or another VS Code) since you opened it. Your save replaced that change.`;
}
