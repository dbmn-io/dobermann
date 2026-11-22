// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: the saved compares, the Hub's Compare list.
 *
 * A compare is started from the Console (its Completed tab, through its View): a draft holding
 * only the Baseline, while Compare's Select step picks what to compare with it. Next saves the
 * picks and the draft becomes a compare; a draft never shows in the Hub's list, and is removed
 * when its tab closes. Open goes straight to Results with the same results, Edit picks them again.
 *
 * A compare is a list of sources. The first is the Baseline (B); the others (C1, C2, C3, in
 * the order they were picked) are each measured against it. Release 1 has one kind of source,
 * a saved result of the same endpoint read through the same View. The list is built for more:
 * a result of another endpoint (its own View) or a file, each with a map of its columns onto
 * the Baseline's (key pairs and column pairs, with simple transforms, as Run Batch maps a
 * file). Those are added as new `kind`s; a saved compare never needs migrating for them.
 *
 * Kept in the same small state store as the Console's Views (the account's catalogue store
 * while signed in, else the app's own). It stores no rows: those stay in History.
 */
import { freeReportName, REPORT_NAME_MAX } from './report-name';
import type { RunHeaderValue } from './compare-runs';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';

/** How an old saved compare's sides met (kept to read compares saved by v0.4.0). */
export type CompareJoin = 'full' | 'left' | 'right' | 'inner';

export const COMPARES_KEY = 'compares';

/** At most this many results in one compare, the Baseline included. */
export const MAX_COMPARE_SOURCES = 4;

/** A saved result of an endpoint, read through one of the endpoint's Console Views. */
export interface CompareResultSource {
    kind: 'result';
    endpointId: string;
    view: string;
    executionId: string;
    isBatch: boolean;
    environment: string;
    executedAt: string;
    /** The environment's header values when it ran (org 880): what tells two runs of one environment apart. */
    header?: RunHeaderValue[];
}

export type CompareSource = CompareResultSource;

/** How the records are matched and compared. */
export interface CompareSetup {
    keyColumns: string[];
    compareColumns: string[];
    relaxedColumns: string[];
    /** Columns Results show beside the compared ones but never compare (ids, created times...). */
    shownColumns?: string[];
    join: CompareJoin;
    /** Compared columns hidden on Results (the gear, or × on a heading): not compared, never the View. */
    hiddenColumns?: string[];
    /** The compared columns in the order Results show them (dragged by their headings). */
    columnOrder?: string[];
    /** A column's width on Results set by the user, in px, by its heading (`column|` or `column|place`). */
    columnWidths?: Record<string, number>;
    /** How Results are sorted (a heading clicked); absent: the compare's own order. */
    sort?: { column: string; place?: number; dir: 'asc' | 'desc' };
}

export interface SavedCompare {
    id: string;
    /** What the user calls it: no other report's name (report-name.ts). Given when it first opens, from its endpoint. */
    name?: string;
    /** The Baseline first, then the results measured against it. */
    sources: CompareSource[];
    /** Set once the compare has run. */
    setup?: CompareSetup;
    createdAt: string;
    /** The last time it ran, and what it found (the Hub list's line). */
    comparedAt?: string;
    counts?: Record<string, number>;
}

export type CompareState = Pick<IKeyValueStore, 'get' | 'update'>;

const FINISHED = new Set(['completed', 'completed_with_errors', 'failed', 'error', 'stopped', 'cancelled']);

/** A run Compare can use: finished (an error run too), and a run of its own (not one request of a batch). */
export function isComparableRun(e: { executionType?: string; status?: unknown }): boolean {
    return (e.executionType === 'individual' || e.executionType === 'batch') && FINISHED.has(String(e.status).toLowerCase());
}

/** A compare still being set up: only its Baseline is picked (Select's Next completes it). */
export function isDraft(compare: SavedCompare): boolean {
    return compare.sources.length < 2;
}

/** The compares the Hub lists: every one past Select, newest first. */
export function savedCompares(state: CompareState): SavedCompare[] {
    return listCompares(state).filter(c => !isDraft(c));
}

/** Newest first, drafts included. */
export function listCompares(state: CompareState): SavedCompare[] {
    const list = state.get<SavedCompare[]>(COMPARES_KEY);
    return Array.isArray(list) ? list.filter(c => c && Array.isArray(c.sources) && c.sources.length > 0) : [];
}

export function getCompare(state: CompareState, id: string): SavedCompare | undefined {
    return listCompares(state).find(c => c.id === id);
}

/** Save a compare, newest first. */
export async function saveCompare(state: CompareState, compare: SavedCompare): Promise<void> {
    const rest = listCompares(state).filter(c => c.id !== compare.id);
    await state.update(COMPARES_KEY, [compare, ...rest]);
}

export async function removeCompare(state: CompareState, id: string): Promise<void> {
    await state.update(COMPARES_KEY, listCompares(state).filter(c => c.id !== id));
}

function newId(): string {
    return `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const sameSources = (x: CompareSource[], y: CompareSource[]): boolean =>
    x.length === y.length && x.every((s, i) => s.executionId === y[i].executionId && s.view === y[i].view && s.endpointId === y[i].endpointId);

/**
 * The setup of the newest compare of this endpoint and View: a new compare starts from the
 * key and columns used last time (the user still checks Match).
 */
export function latestSetup(state: CompareState, endpointId: string, view: string): CompareSetup | undefined {
    return listCompares(state)
        .filter(c => c.setup && c.sources[0].endpointId === endpointId && c.sources[0].view === view)
        .sort((x, y) => (y.comparedAt ?? y.createdAt).localeCompare(x.comparedAt ?? x.createdAt))[0]?.setup;
}

/**
 * A compare of these sources. The same results in the same order open the compare already
 * saved; otherwise a new one is saved, with the key and columns of the last compare of this
 * endpoint and View.
 */
export async function createCompare(state: CompareState, sources: CompareSource[]): Promise<SavedCompare> {
    if (sources.length < 2) throw new Error('Pick at least one result to compare with.');
    if (sources.length > MAX_COMPARE_SOURCES) throw new Error(`Compare up to ${MAX_COMPARE_SOURCES} results at a time.`);
    const existing = listCompares(state).find(c => sameSources(c.sources, sources));
    if (existing) return existing;
    const setup = latestSetup(state, sources[0].endpointId, sources[0].view);
    const compare: SavedCompare = {
        id: newId(),
        sources,
        ...(setup ? { setup } : {}),
        createdAt: new Date().toISOString(),
    };
    await saveCompare(state, compare);
    return compare;
}

/**
 * The Console's Compare: a draft of this Baseline, for Compare's Select step to complete. A draft
 * of the same Baseline and View is opened again rather than saved twice.
 */
export async function createDraft(state: CompareState, baseline: CompareSource): Promise<SavedCompare> {
    const existing = listCompares(state).find(c => isDraft(c) && sameSources(c.sources, [baseline]));
    if (existing) return existing;
    const setup = latestSetup(state, baseline.endpointId, baseline.view);
    const draft: SavedCompare = { id: newId(), sources: [baseline], ...(setup ? { setup } : {}), createdAt: new Date().toISOString() };
    await saveCompare(state, draft);
    return draft;
}

/** A copy to change without losing the original. */
export async function duplicateCompare(state: CompareState, id: string): Promise<SavedCompare | undefined> {
    const from = getCompare(state, id);
    if (!from) return undefined;
    const copy: SavedCompare = { id: newId(), ...(from.name ? { name: freeReportName(state, `${from.name.slice(0, REPORT_NAME_MAX - 5)} copy`) } : {}), sources: from.sources.map(s => ({ ...s })), ...(from.setup ? { setup: { ...from.setup } } : {}), createdAt: new Date().toISOString() };
    await saveCompare(state, copy);
    return copy;
}

/** How many saved compares read each of this endpoint's Views (the Console flags them). */
export function viewsInCompares(state: CompareState, endpointId: string): Record<string, number> {
    const used: Record<string, number> = {};
    for (const c of savedCompares(state)) {
        const views = new Set(c.sources.filter(s => s.endpointId === endpointId).map(s => s.view));
        views.forEach(v => { used[v] = (used[v] ?? 0) + 1; });
    }
    return used;
}
