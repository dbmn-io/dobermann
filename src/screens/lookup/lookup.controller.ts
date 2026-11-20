// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A lookup table's screen (src/services/lookup-tables): its rows and columns in the design
 * system's editable table, kept as they are typed. There is no Save button: edits are shared
 * live (a query that uses the table reads it as it is now), so each change is kept a moment after
 * it is made, once the table can be kept (a key one value per row, every row with one).
 *
 * The page (src/webviews/lookup/lookup-page.js) does the editing and says what it holds; this
 * keeps it, and tells the page when the table changes elsewhere (renamed from the Hub's list,
 * deleted).
 */
import type { ScreenSession } from '../screen-session';
import {
    LOOKUP_MAX_COLUMNS, LOOKUP_MAX_ROWS, type LookupColumn, type LookupTablesStore
} from '../../services/lookup-tables/lookup-tables';

export interface LookupPorts {
    store: LookupTablesStore;
    toast: { info(message: string): void; warn(message: string): void; error(message: string): void };
    host?: {
        /** The table's name changed (its tab is its name). */
        renamed?(name: string): void;
    };
}

export interface LookupConfig {
    /** The table (lkp-…). */
    id: string;
}

export type LookupMessage =
    | { type: 'lookup.ready' }
    | { type: 'lookup.save'; table: { columns: LookupColumn[]; rows: Array<Record<string, unknown>> }; seq?: number }
    | { type: 'lookup.rename'; name: string }
    | { type: string; [key: string]: unknown };

export class LookupController {
    private readonly stop: () => void;
    /** A save of ours in progress: the store's change signal for it is ours, not news. */
    private saving = false;

    constructor(private readonly session: ScreenSession, private readonly ports: LookupPorts, private readonly config: LookupConfig) {
        this.stop = ports.store.onChange(change => {
            if (change.id !== config.id || this.saving) return;
            if (change.kind === 'deleted') this.session.post({ type: 'lookup.missing' });
            else void this.load();
        });
    }

    async handleMessage(message: LookupMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'lookup.ready': return await this.load();
                case 'lookup.save': return await this.save(message as Extract<LookupMessage, { type: 'lookup.save' }>);
                case 'lookup.rename': return await this.rename(String((message as { name?: unknown }).name ?? ''));
                default: return;
            }
        } catch (error) {
            this.ports.toast.error(`Lookup table: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** The table as kept, to the page (or that it is gone). */
    private async load(): Promise<void> {
        const table = await this.ports.store.get(this.config.id);
        if (!table) {
            this.session.post({ type: 'lookup.missing' });
            return;
        }
        this.session.post({ type: 'lookup.load', table, limits: { columns: LOOKUP_MAX_COLUMNS, rows: LOOKUP_MAX_ROWS } });
    }

    /** The page's columns and rows, kept under the table's own name. The page hears whether it was. */
    private async save(message: Extract<LookupMessage, { type: 'lookup.save' }>): Promise<void> {
        const seq = message.seq;
        const kept = await this.ports.store.get(this.config.id);
        if (!kept) {
            this.session.post({ type: 'lookup.missing' });
            return;
        }
        const columns = Array.isArray(message.table?.columns) ? message.table.columns : [];
        const rows = Array.isArray(message.table?.rows) ? message.table.rows : [];
        this.saving = true;
        try {
            const saved = await this.ports.store.save({
                id: kept.id,
                name: kept.name,
                columns: columns.map(c => ({ id: String(c.id), name: String(c.name ?? c.id), ...(c.key ? { key: true } : {}) })),
                rows: rows.map(row => {
                    const out: Record<string, string> = {};
                    columns.forEach(c => { const v = row[c.id]; out[c.id] = v === null || v === undefined ? '' : String(v); });
                    return out;
                })
            });
            this.session.post({ type: 'lookup.saved', seq, updatedAt: saved.updatedAt, rows: saved.rows.length });
        } catch (error) {
            this.session.post({ type: 'lookup.notSaved', seq, reason: error instanceof Error ? error.message : String(error) });
        } finally {
            this.saving = false;
        }
    }

    /** Renamed (the Hub's list, while the tab is open): kept, and the tab follows. */
    private async rename(name: string): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
            const saved = await this.ports.store.rename(this.config.id, trimmed);
            this.ports.host?.renamed?.(saved.name);
        } catch (error) {
            this.ports.toast.warn(error instanceof Error ? error.message : String(error));
        }
    }

    dispose(): void {
        this.stop();
    }
}
