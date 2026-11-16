// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Recent Endpoints Service
 *
 * Keeps a small most-recently-used list of endpoint ids so the Hub catalogue
 * can surface a "Recent" section at the top of the tree. An endpoint is
 * "touched" when it is saved (create or edit). Opening one is deliberately
 * NOT a touch — re-sorting the list the moment a row is clicked is jarring.
 * Runs reach the Recent section through transaction history instead.
 *
 * Storage: `context.globalState` (user preference, shared across workspaces —
 * see Architecture.md → State Boundaries). Deliberately NOT webview state,
 * which is tied to the panel lifetime and easy to lose.
 *
 * Runs are derivable from transaction history in the webview; this list
 * covers the create/edit signals that history cannot see.
 */

import { EventEmitter } from '../../platform/events';

export interface RecentEndpointEntry {
    id: string;
    /** Epoch millis of the most recent touch. */
    touchedAt: number;
}

/** The slice of `vscode.Memento` we depend on — keeps the service testable. */
export interface RecentEndpointsStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

export const RECENT_ENDPOINTS_STORAGE_KEY = 'dbmn_recent_endpoints';
export const RECENT_ENDPOINTS_MAX = 20;

export class RecentEndpointsService {
    private readonly emitter = new EventEmitter<void>();
    private entries: RecentEndpointEntry[];

    constructor(
        private readonly store: RecentEndpointsStore,
        private readonly now: () => number = () => Date.now()
    ) {
        this.entries = this.load();
    }

    /** Newest first. */
    list(): RecentEndpointEntry[] {
        return this.entries.map(e => ({ ...e }));
    }

    /** Record activity on an endpoint. Draft ids (`new-*`) are ignored until saved. */
    async touch(id: string): Promise<void> {
        if (!id || id.startsWith('new-')) return;
        const touchedAt = this.now();
        this.entries = [{ id, touchedAt }, ...this.entries.filter(e => e.id !== id)]
            .slice(0, RECENT_ENDPOINTS_MAX);
        await this.persist();
    }

    /** Drop an endpoint (e.g. after deletion). No-op when absent. */
    async remove(id: string): Promise<void> {
        const before = this.entries.length;
        this.entries = this.entries.filter(e => e.id !== id);
        if (this.entries.length !== before) await this.persist();
    }

    /** Drop every id not in `existingIds` — self-heals after deletes or imports. */
    async prune(existingIds: Iterable<string>): Promise<void> {
        const keep = new Set(existingIds);
        const before = this.entries.length;
        this.entries = this.entries.filter(e => keep.has(e.id));
        if (this.entries.length !== before) await this.persist();
    }

    onDidChange(listener: () => void): { dispose(): void } {
        return this.emitter.event(listener);
    }

    private load(): RecentEndpointEntry[] {
        const raw = this.store.get<unknown>(RECENT_ENDPOINTS_STORAGE_KEY);
        if (!Array.isArray(raw)) return [];
        const seen = new Set<string>();
        const out: RecentEndpointEntry[] = [];
        for (const item of raw) {
            const id = (item as { id?: unknown })?.id;
            const touchedAt = (item as { touchedAt?: unknown })?.touchedAt;
            if (typeof id !== 'string' || !id || typeof touchedAt !== 'number') continue;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, touchedAt });
        }
        out.sort((a, b) => b.touchedAt - a.touchedAt);
        return out.slice(0, RECENT_ENDPOINTS_MAX);
    }

    private async persist(): Promise<void> {
        await this.store.update(RECENT_ENDPOINTS_STORAGE_KEY, this.entries);
        this.emitter.fire();
    }
}
