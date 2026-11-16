// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #342: a device's own catalogue, copied to the user's account once. The device's copy is left
 * exactly as it was (older versions of the extension keep using it); the new one ignores it. Into an empty account that is everything; into one that already has items (made
 * in the web app, or on another device) it is only what the account doesn't have, matched by
 * id, or as a duplicate (see sameAs): the account's copy of an item always wins. The user also
 * keeps an ordinary Export saved before the move (VS Code's connector). Systems go
 * before endpoints and environments (they refer to Systems by id). The items go through
 * CatalogueState like any save: the shared catalogue gets the safe form, secrets go to this
 * device's vault, never upward.
 */
import type { StoreContext } from '../../platform/interfaces/store-context.interface';
import { CATALOGUE_KEYS } from './catalogue-state';


/** Systems first: endpoints and environments refer to them. */
const ORDER = ['apiSystems', 'apiEndpoints', 'environments'];

type Item = { id: string; name?: string; baseUrl?: string; systemId?: string; method?: string; path?: string };
type Collection = Record<string, unknown> & { activeEnvironmentId?: string };

function items(store: StoreContext, key: string): Item[] {
    return ((store.globalState.get(key) as Record<string, Item[]> | undefined)?.[CATALOGUE_KEYS[key].list]) ?? [];
}

/**
 * Worth adding: every endpoint, and every environment with a base URL. A new install's
 * placeholder ("Default", no base URL) can't run anything, so new users aren't asked about it.
 * Every System comes along (joining an account System of the same name); Systems alone don't
 * make a device worth moving.
 */
function worthAdding(key: string, item: Item): boolean {
    return key !== 'environments' || Boolean(item.baseUrl);
}

const systemName = (system: Item) => (system.name ?? '').trim().toLowerCase();

/**
 * The same item made twice (in the web app and in VS Code, say) has two ids. Same System,
 * method, path and name is the same endpoint; same name and base URL, the same environment.
 */
const sameAs: Record<string, (item: Item) => string> = {
    apiEndpoints: e => [e.systemId ?? '', (e.method ?? '').toUpperCase(), (e.path ?? '').trim(), (e.name ?? '').trim().toLowerCase()].join('|'),
    environments: e => [(e.name ?? '').trim().toLowerCase(), (e.baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase()].join('|')
};

/** The device's items the shared catalogue doesn't have, per collection key. */
export function deviceItemsMissing(local: StoreContext, shared: StoreContext): Record<string, Item[]> {
    const missing: Record<string, Item[]> = {};
    for (const key of ['apiEndpoints', 'environments']) {
        const have = new Set(items(shared, key).map(i => i.id));
        missing[key] = items(local, key).filter(i => worthAdding(key, i) && !have.has(i.id));
    }
    // A device System named like one the account has (made in the web app, or on another
    // device) joins it, as Import matches Systems by name (#290): its items move into the
    // account's System, and no second "dbmn" appears.
    const accountSystems = items(shared, 'apiSystems');
    const accountByName = new Map(accountSystems.map(s => [systemName(s), s.id]));
    const joins = new Map<string, string>();
    for (const system of items(local, 'apiSystems')) {
        const match = accountByName.get(systemName(system));
        if (match && match !== system.id) joins.set(system.id, match);
    }
    for (const key of ['apiEndpoints', 'environments']) {
        const inAccount = new Set(items(shared, key).map(sameAs[key]));
        missing[key] = missing[key]
            .map(i => (i.systemId && joins.has(i.systemId) ? { ...i, systemId: joins.get(i.systemId) } : i))
            .filter(i => !inAccount.has(sameAs[key](i)));   // a duplicate: the account's copy wins
    }
    const haveSystems = new Set(accountSystems.map(i => i.id));
    missing.apiSystems = items(local, 'apiSystems').filter(s => !haveSystems.has(s.id) && !joins.has(s.id));
    return missing;
}

/** What the device has that the shared catalogue lacks: ids, and how many of each to say. */
export function deviceCatalogueMissing(local: StoreContext, shared: StoreContext): { ids: string[]; endpoints: number; environments: number } {
    const missing = deviceItemsMissing(local, shared);
    return {
        ids: [...missing.apiEndpoints, ...missing.environments].map(i => i.id),
        endpoints: missing.apiEndpoints.length,
        environments: missing.environments.length
    };
}

/** "1 endpoint and 2 environments", for the offer. */
export function describeCatalogueCount(endpoints: number, environments: number): string {
    const part = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    if (endpoints && environments) return `${part(endpoints, 'endpoint')} and ${part(environments, 'environment')}`;
    return endpoints ? part(endpoints, 'endpoint') : part(environments, 'environment');
}

/** Add the device's missing items (and the Systems they use) to the shared catalogue. Returns how many endpoints and environments were added. */
export async function addDeviceCatalogue(local: StoreContext, shared: StoreContext): Promise<number> {
    const missing = deviceItemsMissing(local, shared);
    const collections: Record<string, unknown> = {};
    for (const key of Object.keys(CATALOGUE_KEYS)) collections[key] = local.globalState.get(key);
    let added = 0;
    for (const key of ORDER) {
        if (missing[key].length === 0) continue;
        const { list } = CATALOGUE_KEYS[key];
        const current = (shared.globalState.get(key) as Collection | undefined) ?? (collections[key] as Collection);
        const next: Collection = { ...current, [list]: [...((current[list] as Item[] | undefined) ?? []), ...missing[key]] };
        // An account with no active environment takes this device's, when it came across
        const localActive = (collections[key] as Collection | undefined)?.activeEnvironmentId;
        if (key === 'environments' && !next.activeEnvironmentId && missing[key].some(e => e.id === localActive)) {
            next.activeEnvironmentId = localActive;
        }
        await shared.globalState.update(key, next);
        if (key !== 'apiSystems') added += missing[key].length;
    }
    return added;
}

/** Whether the device has a catalogue of its own to move: an endpoint, or a usable environment. */
export function deviceHasCatalogue(local: StoreContext): boolean {
    return items(local, 'apiEndpoints').length > 0 || items(local, 'environments').some(e => worthAdding('environments', e));
}

/**
 * The device's environments, whole (secrets included), for the vault: one the account has as a
 * duplicate (another id) carries the account's id, so its secrets serve the account's copy.
 */
export function deviceEnvironmentsForVault<T>(local: StoreContext, shared: StoreContext): T[] {
    const accountIds = new Set(items(shared, 'environments').map(e => e.id));
    const accountBySame = new Map(items(shared, 'environments').map(e => [sameAs.environments(e), e.id]));
    return items(local, 'environments').map(e => {
        const duplicateOf = accountIds.has(e.id) ? undefined : accountBySame.get(sameAs.environments(e));
        return duplicateOf ? { ...e, id: duplicateOf } : e;
    }) as unknown as T[];
}
