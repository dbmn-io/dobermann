// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #341: the shared `CatalogStore`, kept in Supabase (tables from #340). VS Code and the
 * web app both use it. Each passes in a Supabase client it built itself: VS Code with the DBMN
 * session token, the web app with its own sign-in. It is a platform adapter (#417): the core
 * knows the `CatalogStore` port and its local stores, never this file or supabase-js.
 *
 * - Versioned writes: an update names the version it read (`version = eq.N`). Zero rows means
 *   someone changed it elsewhere, and the write throws `CatalogConflictError`.
 * - Deletes are soft (`deleted_at`), so other devices hear about them through Realtime and a
 *   re-save brings the item back.
 * - `connect()` subscribes to Realtime. Changes made on other devices arrive as `onChanged`
 *   events. Our own writes fire once (locally), not twice: the echo carries a version we have
 *   already announced.
 * - Realtime needs the user's token handed over explicitly: with supabase-js's `accessToken`
 *   option it otherwise joins as anon, and Row Level Security filters out every change (found
 *   2026-10-06). So the store takes the same `accessToken()` the host gave supabase-js, sends it
 *   on connect, and re-sends it every few minutes so a refreshed session keeps listening.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { EventEmitter } from '../events';
import { subscribeAndListen } from './realtime-ready';
import { settled } from './settled';
import { CatalogChange, CatalogCollection, CatalogConflictError, CatalogStore, SequenceDraw } from '../../services/catalogue/catalog-store.interface';
import { CatalogueConsoleViews, CatalogueEndpoint, CatalogueEnvironment, CatalogueKind, CatalogueSystem, Versioned } from '../../services/catalogue/catalogue.types';

const TABLES: Record<CatalogueKind, string> = {
    endpoints: 'catalog_endpoints',
    systems: 'catalog_systems',
    environments: 'catalog_environments',
    views: 'catalog_views'
};

interface CatalogueRow<T> {
    id: string;
    item: T;
    version: number;
    updated_at: string;
    deleted_at: string | null;
}

function versioned<T>(row: CatalogueRow<T>): Versioned<T> {
    return { item: row.item, version: row.version, updatedAt: Date.parse(row.updated_at) };
}

function failed(action: string, error: { message: string } | null): never {
    throw new Error(`Catalogue ${action} failed: ${error?.message ?? 'no response'}`);
}

class SupabaseCollection<T extends { id: string }> implements CatalogCollection<T> {
    constructor(
        private readonly client: SupabaseClient,
        private readonly kind: CatalogueKind,
        private readonly announce: (change: CatalogChange) => void
    ) {}

    private get table() {
        return this.client.from(TABLES[this.kind]);
    }

    async list(): Promise<Versioned<T>[]> {
        const { data, error } = await settled(() => this.table.select('id, item, version, updated_at, deleted_at').is('deleted_at', null));
        if (error) failed(`list ${this.kind}`, error);
        return (data as CatalogueRow<T>[]).map(versioned);
    }

    async get(id: string): Promise<Versioned<T> | undefined> {
        const row = await this.current(id);
        return row && !row.deleted_at ? versioned(row) : undefined;
    }

    async save(item: T, expectedVersion?: number): Promise<Versioned<T>> {
        let row: CatalogueRow<T>;
        if (expectedVersion === 0) {
            // Create only: a clash with an existing id is a conflict, never an overwrite
            const { data, error } = await settled(() => this.table
                .insert({ id: item.id, item })
                .select('id, item, version, updated_at, deleted_at')
                .single());
            if (error && /duplicate key|23505/i.test(`${error.message} ${(error as { code?: string }).code ?? ''}`)) {
                throw new CatalogConflictError(this.kind, item.id, 0, (await this.current(item.id))?.version);
            }
            if (error || !data) failed(`create ${this.kind} ${item.id}`, error);
            row = data as unknown as CatalogueRow<T>;
        } else if (expectedVersion === undefined) {
            const { data, error } = await settled(() => this.table
                .upsert({ id: item.id, item, deleted_at: null }, { onConflict: 'owner_user_id,id' })
                .select('id, item, version, updated_at, deleted_at')
                .single());
            if (error || !data) failed(`save ${this.kind} ${item.id}`, error);
            row = data as unknown as CatalogueRow<T>;
        } else {
            const { data, error } = await settled(() => this.table
                .update({ item, deleted_at: null })
                .eq('id', item.id)
                .eq('version', expectedVersion)
                .select('id, item, version, updated_at, deleted_at'));
            if (error) failed(`save ${this.kind} ${item.id}`, error);
            if (!data || data.length === 0) {
                throw new CatalogConflictError(this.kind, item.id, expectedVersion, (await this.current(item.id))?.version);
            }
            row = data[0] as CatalogueRow<T>;
        }
        this.announce({ kind: this.kind, id: item.id, deleted: false, version: row.version });
        return versioned(row);
    }

    async delete(id: string, expectedVersion?: number): Promise<boolean> {
        const { data, error } = await settled(() => {
            let query = this.table.update({ deleted_at: new Date().toISOString() }).eq('id', id).is('deleted_at', null);
            if (expectedVersion !== undefined) {
                query = query.eq('version', expectedVersion);
            }
            return query.select('id, item, version, updated_at, deleted_at');
        });
        if (error) failed(`delete ${this.kind} ${id}`, error);
        if (!data || data.length === 0) {
            const current = await this.current(id);
            if (expectedVersion !== undefined && current && !current.deleted_at) {
                throw new CatalogConflictError(this.kind, id, expectedVersion, current.version);
            }
            return false;
        }
        const row = data[0] as CatalogueRow<T>;
        this.announce({ kind: this.kind, id, deleted: true, version: row.version });
        return true;
    }

    /** The stored row, deleted or not. */
    private async current(id: string): Promise<CatalogueRow<T> | undefined> {
        const { data, error } = await settled(() => this.table.select('id, item, version, updated_at, deleted_at').eq('id', id).maybeSingle());
        if (error) failed(`read ${this.kind} ${id}`, error);
        return (data as CatalogueRow<T> | null) ?? undefined;
    }
}

export class SupabaseCatalogStore implements CatalogStore {
    private readonly changed = new EventEmitter<CatalogChange>();
    readonly onChanged = this.changed.event;
    readonly endpoints: CatalogCollection<CatalogueEndpoint>;
    readonly systems: CatalogCollection<CatalogueSystem>;
    readonly environments: CatalogCollection<CatalogueEnvironment>;
    readonly views: CatalogCollection<CatalogueConsoleViews>;

    /** Highest version announced per `kind:id`, so a Realtime echo of our own write is dropped. */
    private readonly announced = new Map<string, number>();
    private channel?: RealtimeChannel;
    private authTimer?: ReturnType<typeof setInterval>;

    constructor(
        private readonly client: SupabaseClient,
        private readonly options: { accessToken?: () => Promise<string | null | undefined> } = {}
    ) {
        const announce = (change: CatalogChange) => this.announce(change);
        this.endpoints = new SupabaseCollection<CatalogueEndpoint>(client, 'endpoints', announce);
        this.systems = new SupabaseCollection<CatalogueSystem>(client, 'systems', announce);
        this.views = new SupabaseCollection<CatalogueConsoleViews>(client, 'views', announce);
        this.environments = new SupabaseCollection<CatalogueEnvironment>(client, 'environments', announce);
    }

    private announce(change: CatalogChange): void {
        // Every write, soft deletes included, bumps the version (#340's trigger), so the version
        // alone tells a new change from the echo of one already announced.
        const key = `${change.kind}:${change.id}`;
        const seen = this.announced.get(key);
        if (seen !== undefined && seen >= change.version) {
            return;
        }
        this.announced.set(key, change.version);
        this.changed.fire(change);
    }

    /** Listen for changes made on other devices. Resolves once Realtime has subscribed. */
    async connect(): Promise<void> {
        if (this.channel) {
            return;
        }
        await this.sendRealtimeAuth();
        this.authTimer = setInterval(() => { this.sendRealtimeAuth().catch(() => undefined); }, 4 * 60 * 1000);   // (no token: #2, next time)
        const channel = this.client.channel(`catalogue-${Math.random().toString(36).slice(2)}`);
        for (const [kind, table] of Object.entries(TABLES) as Array<[CatalogueKind, string]>) {
            channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
                const row = (payload.new && Object.keys(payload.new).length ? payload.new : payload.old) as Partial<CatalogueRow<unknown>>;
                if (!row.id || row.version === undefined) {
                    return;
                }
                const deleted = payload.eventType === 'DELETE' || Boolean(row.deleted_at);
                this.announce({ kind, id: row.id, deleted, version: row.version });
            });
        }
        this.channel = channel;
        return subscribeAndListen(channel, 'Catalogue');
    }

    private async sendRealtimeAuth(): Promise<void> {
        const token = await this.options.accessToken?.();
        if (token) {
            await this.client.realtime.setAuth(token);
        }
    }

    async dispose(): Promise<void> {
        if (this.authTimer) {
            clearInterval(this.authTimer);
            this.authTimer = undefined;
        }
        if (this.channel) {
            await this.client.removeChannel(this.channel);
            this.channel = undefined;
        }
        this.changed.dispose();
    }

    /**
     * #342: VS Code moved this device's catalogue to the account (once per device; a device
     * with nothing to move records zeros). Counts and VS Code's machine id only.
     */
    async recordMigration(deviceId: string, moved: { endpoints: number; environments: number }): Promise<void> {
        const { error } = await settled(() => this.client.from('catalog_migrations')
            .upsert({ device_id: deviceId, ...moved, migrated_at: new Date().toISOString() }, { onConflict: 'owner_user_id,device_id' }));
        if (error) {
            throw new Error(`Could not record the catalogue move: ${error.message}`);
        }
    }

    /** Whether this account has signed in from VS Code (and so has its VS Code catalogue). */
    async hasMigratedFromVsCode(): Promise<boolean> {
        const { data, error } = await settled(() => this.client.from('catalog_migrations').select('device_id').limit(1));
        if (error) {
            throw new Error(`Could not read the catalogue moves: ${error.message}`);
        }
        return (data?.length ?? 0) > 0;
    }

    async nextSequence(endpointId: string, arrayPath?: string, options: SequenceDraw = {}): Promise<number> {
        const { data, error } = await settled(() => this.client.rpc('catalog_next_sequence', {
            p_endpoint_id: endpointId,
            p_array_path: arrayPath ?? '',
            p_count: options.count ?? 1,
            p_after: options.after ?? 0
        }));
        if (error) failed(`next sequence for ${endpointId}`, error);
        return Number(data);
    }

    async returnSequence(endpointId: string, arrayPath: string | undefined, reservedTo: number, usedTo: number): Promise<boolean> {
        const { data, error } = await settled(() => this.client.rpc('catalog_return_sequence', {
            p_endpoint_id: endpointId,
            p_array_path: arrayPath ?? '',
            p_reserved_to: reservedTo,
            p_used_to: usedTo
        }));
        if (error) failed(`return sequence for ${endpointId}`, error);
        return data === true;
    }

    async resetSequence(endpointId: string, arrayPath?: string): Promise<void> {
        const { error } = await settled(() => this.client.rpc('catalog_reset_sequence', {
            p_endpoint_id: endpointId,
            ...(arrayPath === undefined ? {} : { p_array_path: arrayPath })
        }));
        if (error) failed(`reset sequence for ${endpointId}`, error);
    }

    async resetArraySequences(endpointId: string): Promise<void> {
        const { error } = await settled(() => this.client.rpc('catalog_reset_sequence', { p_endpoint_id: endpointId, p_array_path: '*' }));
        if (error) failed(`reset array sequences for ${endpointId}`, error);
    }
}
