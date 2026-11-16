// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415: Global Systems. One System concept, two kinds: a user's own System (the catalogue, only
 * its owner sees it) and a global System, configured by DBMN in Supabase (`global_systems`) and
 * listed for every signed-in user. Their System configuration is data from Supabase: the app
 * applies it and never carries any particular system's configuration in its code.
 *
 * Cached, so the list keeps working offline. #418: a sign-in is not needed to read it; the
 * active rows are open to anyone. The list is configuration: a successful fetch replaces it, so
 * a System DBMN withdraws (`is_active = false`) leaves. A failed fetch keeps what was cached.
 */
import { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import { SystemConfig, SystemConfigSchema } from '../../data-loading/system-schema';
import { parseSystemConfiguration } from './system-configuration';
import { dbmnStorageKeys, getBackend } from '../dbmn-backend/backend-config';

/** The DBMN sign-in this service reads with: the extension's auth service, or the web app's session. */
export interface DbmnSessionAuth {
    isAuthenticated(): boolean;
    ensureValidSession(): Promise<{ status: string }>;
    getSession(): { accessToken: string } | null | undefined;
}

/** Every six hours. */
export const GLOBAL_SYSTEMS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface GlobalSystemRow {
    id: string;
    item: unknown;
}

/**
 * A row as a System, or undefined when it doesn't hold one (it is skipped, the rest still
 * load). The row's id is the System's id; it is global whatever the item says. Its
 * configuration is checked against version 1 of the shape: one that doesn't fit is dropped
 * and reported, and the System is still listed without it.
 */
export function globalSystemFromRow(row: GlobalSystemRow): SystemConfig | undefined {
    if (!row || typeof row.id !== 'string' || !row.item || typeof row.item !== 'object') return undefined;
    const item = row.item as Record<string, unknown>;
    let config: Record<string, unknown> | undefined;
    if (item.config !== undefined) {
        const checked = parseSystemConfiguration(item.config);
        if (checked.ok) config = checked.config as Record<string, unknown>;
        else console.warn(`[GlobalSystems] issue#415 "${row.id}" has a configuration the app can't use (${checked.error}); listed without it`);
    }
    const parsed = SystemConfigSchema.safeParse({
        ...item,
        config,
        id: row.id,
        name: typeof item.name === 'string' ? item.name : row.id,
        scope: 'global',
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0
    });
    return parsed.success ? parsed.data : undefined;
}

export class GlobalSystemsService {
    private systems: SystemConfig[] = [];
    private listeners: Array<() => void> = [];
    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private inFlight: Promise<void> | undefined;

    constructor(
        /** In the extension `context.globalState`; in the web app the device store. */
        private readonly store: Pick<IKeyValueStore, 'get' | 'update'>,
        /** The DBMN sign-in. */
        private readonly auth: DbmnSessionAuth,
        private readonly apiUrl: () => string = () => getBackend().apiUrl,
        private readonly anonKey: () => string = () => getBackend().anonKey
    ) {
        this.restore();
    }

    /** The global Systems, from the cache: synchronous, never hits the network. */
    getAll(): SystemConfig[] {
        return [...this.systems];
    }

    /** Fetches the list; concurrent callers share one request. A failure keeps the cache. */
    refresh(): Promise<void> {
        this.inFlight ??= this.fetch().finally(() => { this.inFlight = undefined; });
        return this.inFlight;
    }

    startBackgroundRefresh(): void {
        this.stopBackgroundRefresh();
        void this.refresh();
        this.refreshTimer = setInterval(() => void this.refresh(), GLOBAL_SYSTEMS_REFRESH_INTERVAL_MS);
    }

    stopBackgroundRefresh(): void {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
    }

    onChanged(listener: () => void): { dispose: () => void } {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    }

    dispose(): void {
        this.stopBackgroundRefresh();
        this.listeners = [];
    }

    private async fetch(): Promise<void> {
        try {
            // #418: signed out, the list is read as anyone may (the rows are a System's
            // configuration, not a user's data); signed in, with the user's token
            let token = this.anonKey();
            if (this.auth.isAuthenticated()) {
                const refreshed = await this.auth.ensureValidSession();
                const session = this.auth.getSession();
                if (refreshed.status === 'success' && session) token = session.accessToken;
            }
            const response = await fetch(`${this.apiUrl()}/rest/v1/global_systems?select=id,item`, {
                headers: { 'Authorization': `Bearer ${token}`, 'apikey': this.anonKey() }
            });
            if (!response.ok) {
                console.warn(`[GlobalSystems] Fetch failed: ${response.status}, keeping the cached list`);
                return;
            }
            const rows: unknown = await response.json();
            if (!Array.isArray(rows)) {
                console.warn('[GlobalSystems] Malformed response, keeping the cached list');
                return;
            }
            const systems: SystemConfig[] = [];
            for (const row of rows as GlobalSystemRow[]) {
                const system = globalSystemFromRow(row);
                if (system) systems.push(system);
                else console.warn('[GlobalSystems] Skipped a global System that is not a valid System:', row?.id);
            }
            this.replace(systems);
        } catch (error) {
            // Offline, DNS, timeout: the cached list stays
            console.warn('[GlobalSystems] Fetch error, keeping the cached list:', error);
        }
    }

    private replace(systems: SystemConfig[]): void {
        systems.sort((a, b) => a.id.localeCompare(b.id));
        if (JSON.stringify(systems) === JSON.stringify(this.systems)) return;
        this.systems = systems;
        void this.store.update(dbmnStorageKeys().globalSystems, systems);
        for (const listener of this.listeners) {
            try { listener(); } catch (error) { console.warn('[GlobalSystems] Listener threw:', error); }
        }
    }

    private restore(): void {
        try {
            const stored = this.store.get<unknown[]>(dbmnStorageKeys().globalSystems);
            if (!Array.isArray(stored)) return;
            this.systems = stored
                .map(item => globalSystemFromRow({ id: (item as { id?: unknown })?.id as string, item }))
                .filter((s): s is SystemConfig => !!s);
        } catch (error) {
            console.warn('[GlobalSystems] Failed to restore the cached list:', error);
        }
    }
}

/**
 * #415: one wiring for every host (VS Code at activation, the web app at start): the global
 * Systems are listed with the user's own, fetched now, and again every few hours.
 */
export function wireGlobalSystems(
    service: GlobalSystemsService,
    systems: { setGlobalSystems(source: GlobalSystemsService): { dispose(): void } }
): { dispose(): void } {
    const listed = systems.setGlobalSystems(service);
    service.startBackgroundRefresh();
    return { dispose: () => { listed.dispose(); service.dispose(); } };
}
