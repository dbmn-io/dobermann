// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A Console View a query reads is locked: columns can be added to it, but none removed, and its
 * row basis and its name stay as they are (a query's joins and columns name them). The Console
 * saves its Views through keepLockedViews, which puts back what a locked View may not lose.
 */
import { viewColumnIds, type CompareView } from '../compare/compare-side';
import { listQueries, type QueryState } from './query-store';

/** The Views of one request ("GET /path") that saved queries read, and how many queries read each. */
export function viewsInQueries(state: QueryState, of: { endpointId: string; request: string }): Record<string, number> {
    const used: Record<string, number> = {};
    for (const query of listQueries(state)) {
        const names = new Set<string>();
        for (const source of query.sources) {
            if (!source.view) continue;
            // Views go by method and path; a view added before queries kept its request goes by its endpoint
            if (source.request ? source.request === of.request : source.endpointId === of.endpointId) names.add(source.view);
        }
        names.forEach(name => { used[name] = (used[name] ?? 0) + 1; });
    }
    return used;
}

type ViewSettings = { success?: { activeView?: string; defaultView?: string; views?: CompareView[] } } & Record<string, unknown>;

/**
 * The Views to save: `incoming`, with each locked View that lost a column, its row basis or its
 * name put back as it was stored. `reverted` names them.
 */
export function keepLockedViews(stored: unknown, incoming: unknown, locked: string[]): { settings: unknown; reverted: string[] } {
    const before = ((stored as ViewSettings | null)?.success?.views ?? []).filter(v => v && locked.includes(v.name));
    const tab = (incoming as ViewSettings | null)?.success;
    if (!before.length || !tab || !Array.isArray(tab.views)) return { settings: incoming, reverted: [] };
    const reverted: string[] = [];
    const views = [...tab.views];
    for (const was of before) {
        const index = views.findIndex(v => v?.name === was.name);
        if (index < 0) { views.push(was); reverted.push(was.name); continue; }
        const now = views[index];
        const kept = new Set(viewColumnIds(now));
        if (now.rowBasis !== was.rowBasis || viewColumnIds(was).some(id => !kept.has(id))) {
            views[index] = was;
            reverted.push(was.name);
        }
    }
    if (!reverted.length) return { settings: incoming, reverted };
    return { settings: { ...(incoming as object), success: { ...tab, views } }, reverted };
}
