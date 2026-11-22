// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * An old saved compare (compare-store.ts) as a query (2026-11-22: old Compare goes, every compare is a query).
 *
 * The old compare's results are runs of one endpoint read through one View: the Baseline is the query's first view,
 * the others its runs (C1, C2…), each in the compare by a Compare join on the old key. Its compared columns are
 * compared across every run (one group a column, in the old column order, hidden ones left out); its shown columns
 * are the Baseline's, beside them. Its sort comes over when it names a column that is shown. What does not come over
 * is said once when it opens (`notice`): Relaxed columns compare exactly now (James has dropped Relaxed). The old
 * "which rows" choice is left: the Status filter on Results does that job (James: leave it out).
 * Nothing is removed: the old compare stays in the store, and opening it opens this (`fromCompare`).
 */
import type { SavedCompare } from '../compare/compare-store';
import { getEndpointViewScopeKey } from '../console/view-scope-key';
import type { ColumnRef } from './query-types';
import { guessViewName, newQueryId, newSourceId, viewNameFromPath, VIEW_NAME_MAX, type QuerySource, type SavedQuery } from './query-store';

/** What the converter needs of the compare's endpoint (it may be gone: the old compare's own fields are used then). */
export interface CompareEndpointInfo {
    name?: string;
    method?: string;
    path?: string;
    system?: string;
}

export function queryFromCompare(compare: SavedCompare, endpoint: CompareEndpointInfo | undefined, now = new Date().toISOString()): SavedQuery {
    const [first, ...rest] = compare.sources;
    const endpointName = endpoint?.name || compare.name || 'Endpoint';
    const plain = !first.view || /^(default|root|view)$/i.test(first.view.trim());
    const base = viewNameFromPath(endpoint?.path ?? '', first.view) || (plain ? endpointName : first.view);
    const request = endpoint?.method && endpoint.path ? getEndpointViewScopeKey(endpoint.method, endpoint.path) : '';
    const of = (s: SavedCompare['sources'][number]) => ({
        endpointId: s.endpointId, endpointName, view: s.view, request, system: endpoint?.system ?? '',
        executionId: s.executionId, isBatch: s.isBatch, environment: s.environment || 'Unknown', executedAt: s.executedAt
    });
    const head: QuerySource = { id: newSourceId(), name: guessViewName(base, []), ...of(first) };
    const sources: QuerySource[] = [head];
    rest.forEach((s, i) => {
        const run = `C${i + 1}`;
        sources.push({ id: newSourceId(), name: guessViewName(`${head.name.slice(0, VIEW_NAME_MAX - run.length - 1)}_${run}`, sources.map(x => x.name)), ...of(s), runOf: head.id, run });
    });
    const setup = compare.setup;
    const keys = setup?.keyColumns ?? [];
    const joins: SavedQuery['joins'] = sources.slice(1).map(s => ({
        view: s.id, kind: 'compare',
        on: keys.map(column => ({ left: { parts: [{ view: head.id, column }] }, right: { parts: [{ view: s.id, column }] } }))
    }));
    // Compared: the old order first (columnOrder), then any it did not list; hidden ones were not compared
    const hidden = new Set(setup?.hiddenColumns ?? []);
    const order = setup?.columnOrder ?? [];
    const listed = (setup?.compareColumns ?? []).filter(c => !hidden.has(c) && !keys.includes(c));
    const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length + listed.indexOf(c));
    const compared = [...listed].sort((a, b) => rank(a) - rank(b));
    const shown = (setup?.shownColumns ?? []).filter(c => !keys.includes(c) && !compared.includes(c));
    const select: ColumnRef[] = [
        ...compared.flatMap(column => sources.map(s => ({ view: s.id, column, group: column }))),
        ...shown.map(column => ({ view: head.id, column }))
    ];
    // Results' sort, by its place among Results' columns (the key first, as Query shows it)
    const columnsShown = [...keys.map(column => ({ column, place: 0 })), ...compared.flatMap(column => sources.map((_, place) => ({ column, place }))), ...shown.map(column => ({ column, place: 0 }))];
    const sortAt = setup?.sort ? columnsShown.findIndex(c => c.column === setup.sort!.column && c.place === (compared.includes(setup.sort!.column) ? setup.sort!.place ?? 0 : 0)) : -1;
    const relaxed = (setup?.relaxedColumns ?? []).filter(c => compared.includes(c));
    const notice = relaxed.length
        ? `Opened from your old compare. Relaxed matching is gone: ${relaxed.join(', ')} ${relaxed.length === 1 ? 'is' : 'are'} now compared exactly.`
        : undefined;
    return {
        id: newQueryId(), name: compare.name || endpointName, sources, joins,
        ...(select.length ? { select } : {}),
        ...(sortAt >= 0 ? { sort: { column: sortAt, dir: setup!.sort!.dir } } : {}),
        reached: keys.length ? 4 : 2,
        createdAt: compare.createdAt || now, updatedAt: now,
        fromCompare: compare.id,
        ...(notice ? { notice } : {})
    };
}
