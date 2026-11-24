// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Requests tab's Views (#468, host side; messages agreed with the design system 2026-11-24):
 * which of a request's columns show, and in what order, saved under a name. Kept beside the data
 * tabs' Views of the same endpoint (console-views-store.ts, saveRequestViews), so they are shared
 * the same way and travel with the endpoint's export. "All columns" is built in: always first,
 * never saved over or deleted.
 */

export interface RequestsView {
    id: string;
    name: string;
    columns: Array<{ id: string; hidden?: boolean }>;
    order: string[];
    builtIn?: true;
}

export interface RequestViewsStore {
    loadRequestViews(endpointId: string): Promise<unknown[]>;
    saveRequestViews(endpointId: string, views: unknown[]): Promise<void>;
}

export const ALL_COLUMNS: RequestsView = { id: 'all', name: 'All columns', columns: [], order: [], builtIn: true };
export const MAX_VIEW_NAME = 100;
const MAX_COLUMNS = 500;
const MAX_ID = 300;

/** A saved View as kept (anything else in storage is left out, not trusted). */
function clean(raw: unknown): RequestsView | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const v = raw as Record<string, unknown>;
    if (typeof v.id !== 'string' || !v.id || v.id === ALL_COLUMNS.id || typeof v.name !== 'string' || !v.name.trim()) return undefined;
    return { id: v.id, name: v.name.trim().slice(0, MAX_VIEW_NAME), columns: columnsOf(v.columns), order: orderOf(v.order) };
}

function columnsOf(raw: unknown): RequestsView['columns'] {
    const seen = new Set<string>();
    const out: RequestsView['columns'] = [];
    for (const c of Array.isArray(raw) ? raw : []) {
        const id = c && typeof c === 'object' ? (c as { id?: unknown }).id : undefined;
        if (typeof id !== 'string' || !id || id.length > MAX_ID || seen.has(id)) continue;
        seen.add(id);
        out.push((c as { hidden?: unknown }).hidden === true ? { id, hidden: true } : { id });
        if (out.length >= MAX_COLUMNS) break;
    }
    return out;
}

function orderOf(raw: unknown): string[] {
    const ids = (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === 'string' && !!id && id.length <= MAX_ID);
    return [...new Set(ids)].slice(0, MAX_COLUMNS);
}

const newId = () => `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class RequestViews {
    constructor(private readonly store: RequestViewsStore, private readonly makeId: () => string = newId) {}

    /** "All columns", then the saved Views in the order they were made. */
    async list(endpointId: string): Promise<RequestsView[]> {
        return [ALL_COLUMNS, ...(await this.saved(endpointId))];
    }

    /**
     * A View saved: a new one (no id) is given one; an existing one is replaced. A name already
     * taken by another View, an empty name, or "All columns" itself is refused, with why.
     */
    async save(endpointId: string, view: { id?: string | null; name?: unknown; columns?: unknown; order?: unknown }): Promise<{ views: RequestsView[]; id?: string; refused?: string }> {
        const saved = await this.saved(endpointId);
        const name = String(view.name ?? '').replace(/\s+/g, ' ').trim();
        const refuse = async (refused: string) => ({ views: [ALL_COLUMNS, ...saved], refused });
        if (view.id === ALL_COLUMNS.id) return refuse('All columns can\'t be changed: save it under a new name.');
        if (!name) return refuse('A View needs a name.');
        if (name.length > MAX_VIEW_NAME) return refuse(`Up to ${MAX_VIEW_NAME} characters.`);
        const taken = (n: string) => n.toLowerCase() === name.toLowerCase();
        if (taken(ALL_COLUMNS.name) || saved.some(v => taken(v.name) && v.id !== view.id)) return refuse(`There is already a View called ${name}.`);
        const existing = view.id ? saved.findIndex(v => v.id === view.id) : -1;
        const id = existing >= 0 ? saved[existing].id : this.makeId();
        const next: RequestsView = { id, name, columns: columnsOf(view.columns), order: orderOf(view.order) };
        const views = existing >= 0 ? saved.map((v, i) => (i === existing ? next : v)) : [...saved, next];
        await this.store.saveRequestViews(endpointId, views);
        return { views: [ALL_COLUMNS, ...views], id };
    }

    /** A saved View deleted ("All columns" stays). */
    async remove(endpointId: string, id: string): Promise<{ views: RequestsView[]; refused?: string }> {
        const saved = await this.saved(endpointId);
        if (id === ALL_COLUMNS.id) return { views: [ALL_COLUMNS, ...saved], refused: 'All columns is always there.' };
        const views = saved.filter(v => v.id !== id);
        if (views.length !== saved.length) await this.store.saveRequestViews(endpointId, views);
        return { views: [ALL_COLUMNS, ...views] };
    }

    private async saved(endpointId: string): Promise<RequestsView[]> {
        return (await this.store.loadRequestViews(endpointId)).map(clean).filter((v): v is RequestsView => !!v);
    }
}
