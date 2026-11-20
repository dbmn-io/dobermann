// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A compare inside Query: a query with a Compare join (query-types.ts) is a compare.
 *
 * The Baseline is the first Compare join's left view. Every other view in the compare joins the
 * Baseline on the same key: the first Compare join's left side is the key, each later Compare
 * join's left side is made the same (alignCompareJoins), and only its right side, the view's own
 * column, is picked. A compare holds up to four views (MAX_COMPARE_VIEWS), for column room.
 *
 * In SQL each Compare join is a FULL OUTER JOIN whose left side is the key of whichever view in
 * the compare so far has the record: COALESCE(Baseline's key, the next view's key, ...). So a
 * record two later views have, and the Baseline hasn't, is still one row.
 */
import type { QueryJoin, QueryKey } from './query-types';

/** The most views a compare takes, the Baseline included. */
export const MAX_COMPARE_VIEWS = 4;

export interface QueryCompare {
    /** The Baseline: the first Compare join's left view. */
    baseline: string;
    /** The views in the compare, the Baseline first, then each Compare join's view in order. */
    views: string[];
}

/**
 * The compare a query's joins make, or undefined when no join is a Compare: then it is a query.
 * Before its key is picked, its Baseline is `firstView` (the query's first view).
 */
export function queryCompare(joins: QueryJoin[], firstView?: string): QueryCompare | undefined {
    const compares = joins.filter(j => j.kind === 'compare');
    const first = compares[0];
    const baseline = first?.on[0]?.left.parts[0]?.view || (first ? firstView : undefined);
    if (!first || !baseline) return undefined;
    return { baseline, views: [baseline, ...compares.map(j => j.view)] };
}

export function isCompare(joins: QueryJoin[]): boolean {
    return joins.some(j => j.kind === 'compare');
}

const sameKey = (key: QueryKey): QueryKey => JSON.parse(JSON.stringify(key)) as QueryKey;

/**
 * Every Compare join after the first takes the first one's key as its left side, pair for pair:
 * one key across the compare. A pair the first doesn't have is dropped; one it has and this join
 * hasn't is added, its right side still to pick.
 */
export function alignCompareJoins(joins: QueryJoin[], runsOf: Map<string, string> = new Map()): void {
    // A run of a view is always in the compare: it can only be matched with its first run
    for (const join of joins) if (runsOf.has(join.view)) join.kind = 'compare';
    const compares = joins.filter(j => j.kind === 'compare');
    const first = compares[0];
    if (!first) return;
    for (const join of compares.slice(1)) {
        join.on = first.on.map((pair, i) => ({
            left: sameKey(pair.left),
            right: join.on[i]?.right ?? { parts: [{ view: join.view, column: '' }] }
        }));
    }
    // A run's key is its first run's: the same columns of the same View ("sku, the same")
    for (const join of compares) {
        const of = runsOf.get(join.view);
        if (!of) continue;
        const ofKey = (i: number): QueryKey | undefined => (of === first.on[i]?.left.parts[0]?.view ? first.on[i]?.left : compares.find(j => j.view === of)?.on[i]?.right);
        join.on = join.on.map((pair, i) => {
            const key = ofKey(i);
            return key ? { left: pair.left, right: { ...sameKey(key), parts: key.parts.map(p => ({ ...p, view: join.view })) } } : pair;
        });
    }
}

/**
 * A join for a new run of the view `of`: a Compare join on the compare's key; before there is a
 * compare, on the column `of` already joins on (its first join's), else on a column still to pick.
 */
export function runJoin(joins: QueryJoin[], run: string, of: string): QueryJoin {
    const first = joins.find(j => j.kind === 'compare');
    const joinedOn = joins.find(j => j.on.length && j.on.every(p => p.left.parts.length && p.left.parts.every(part => part.view === of && part.column)));
    const left = (first?.on ?? joinedOn?.on ?? []).map(p => sameKey(p.left));
    return { view: run, kind: 'compare', on: left.length ? left.map(l => ({ left: l, right: { parts: [] } })) : [{ left: { parts: [{ view: of, column: '' }] }, right: { parts: [{ view: run, column: '' }] } }] };
}

/**
 * The left side of pair `pair` of join `index`, as the SQL joins on it: for a Compare join after
 * the first, the key of whichever view in the compare so far has the record (each earlier Compare
 * join's right side, after the Baseline's); for any other join, its own left side.
 */
export function compareLeftKeys(joins: QueryJoin[], index: number, pair: number): QueryKey[] {
    const join = joins[index];
    const own = join?.on[pair]?.left;
    if (!join || !own) return [];
    if (join.kind !== 'compare') return [own];
    const earlier = joins.slice(0, index).filter(j => j.kind === 'compare');
    if (!earlier.length) return [own];
    return [earlier[0].on[pair]?.left ?? own, ...earlier.map(j => j.on[pair]?.right).filter((k): k is QueryKey => !!k && k.parts.every(p => !!p.column))];
}

/** A view as grouping needs it: what it reads (endpoint and View), and its columns. */
export interface CompareViewShape {
    id: string;
    endpointId?: string;
    view?: string;
    columns: string[];
}

/**
 * Views read the same way (one endpoint, one View) compare as one group: the Baseline's key
 * column is theirs too. `pullIn` (the join just made a Compare): every view of the Baseline's
 * shape whose join has no column picked yet joins the compare, up to MAX_COMPARE_VIEWS. Then
 * each Compare join of that shape with its own column blank takes the Baseline's (same name,
 * any case), so the key is picked once. A view of another shape keeps its column to pick.
 */
export function groupCompare(joins: QueryJoin[], views: CompareViewShape[], pullIn: boolean): void {
    const compare = queryCompare(joins, views[0]?.id);
    if (!compare) return;
    const base = views.find(v => v.id === compare.baseline);
    if (!base) return;
    const sameShape = (v: CompareViewShape | undefined): v is CompareViewShape => !!v && v.id !== base.id && !!v.endpointId && v.endpointId === base.endpointId && (v.view ?? '') === (base.view ?? '');
    const picked = (j: QueryJoin): boolean => j.on.some(p => p.right.parts.some(x => !!x.column));
    if (pullIn) {
        let size = compare.views.length;
        for (const join of joins) {
            if (size >= MAX_COMPARE_VIEWS) break;
            if (join.kind === 'compare' || picked(join) || !sameShape(views.find(v => v.id === join.view))) continue;
            join.kind = 'compare';
            size++;
        }
        alignCompareJoins(joins);
    }
    const first = joins.find(j => j.kind === 'compare');
    if (!first) return;
    for (const join of joins.filter(j => j.kind === 'compare')) {
        const shape = views.find(v => v.id === join.view);
        if (!sameShape(shape)) continue;
        join.on = first.on.map((pair, i) => {
            const own = join.on[i]?.right;
            if (own && own.parts.some(x => !!x.column)) return { left: pair.left, right: own };
            // The Baseline's key column, by name in this view (any case)
            const parts = pair.left.parts.map(p => {
                const column = shape.columns.find(c => c === p.column) ?? shape.columns.find(c => c.toLowerCase() === p.column.toLowerCase()) ?? '';
                return { ...p, view: join.view, column };
            });
            return { left: pair.left, right: { ...sameKey(pair.left), parts } };
        });
    }
}
