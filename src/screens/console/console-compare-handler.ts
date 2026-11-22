// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare, the Console's host side. A compare starts here, from the Completed tab,
 * through the View the tab shows: this result is the Baseline.
 *
 *  - console.report          — the Console's database button (2026-11-22, James: "New Query",
 *                              "New Compare", "Add to Compare"): this result, through the View the
 *                              tab shows, put in a new query, a new compare (its other runs offered
 *                              at once) or a saved compare (a run of its view joins the compare).
 *                              The query is saved with the result to add (SavedQuery.adding) and
 *                              opened; its screen adds it as Add a view would.
 *  - console.compareViews    — the endpoint's Views that saved compares and queries read (the View
 *                              list flags them, and editing one warns), and the saved compares
 *                              Add to Compare lists.
 *
 * Kept out of console.controller.ts (over the Architecture.md file-size limit); it only routes.
 */
import { getEndpointViewScopeKey } from '../../services/console/view-scope-key';
import { viewsInQueries } from '../../services/query/query-view-lock';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import { comparableRuns, RequestTemplates } from '../../services/compare/compare-runs';
import { viewsInCompares, CompareState } from '../../services/compare/compare-store';
import { freeReportName } from '../../services/compare/report-name';
import { createQuery, getQuery, listQueries, saveQuery } from '../../services/query/query-store';

export interface ConsoleCompareHost {
    getSourceRef(): { executionId?: string; endpointId?: string };
    metadata: Pick<IExecutionMetadataService, 'getExecutionsByEndpoint'>;
    /** The run's environment, for its header variables (org 880, org 840). */
    environments?: { getEnvironment(id: string): Promise<{ variables?: Record<string, string> } | undefined> };
    /** The endpoint's templates: an older single run's header values are read off its request with them. */
    endpoints?: { getEndpoint(id: string): Promise<RequestTemplates | undefined> };
    state: CompareState;
    post(message: Record<string, unknown>): Promise<void>;
    notify(level: 'info' | 'warn' | 'error', message: string): void;
    openCompare?(compareId: string): Promise<void>;
}

export class ConsoleCompareHandler {
    constructor(private readonly host: ConsoleCompareHost) {}

    /** Returns true when the message was ours. */
    async handle(message: { type: string; payload?: unknown }): Promise<boolean> {
        const payload = (message.payload ?? {}) as { view?: string; kind?: string; queryId?: string };
        switch (message.type) {
            case 'console.report': await this.report(payload.view, payload.kind === 'compare' ? 'compare' : payload.kind === 'add' ? 'add' : 'query', payload.queryId); return true;
            case 'console.compareViews': await this.postViews(); return true;
            default: return false;
        }
    }

    /** This result in a new query, a new compare, or a saved compare: saved with it to add, then opened. */
    private async report(view: string | undefined, kind: 'query' | 'compare' | 'add', queryId?: string): Promise<void> {
        const { executionId, endpointId } = this.host.getSourceRef();
        if (!executionId || !endpointId) {
            this.host.notify('warn', 'Save this endpoint and run it again: then its results can go in a query.');
            return;
        }
        const endpoint = await this.host.endpoints?.getEndpoint(endpointId).catch(() => undefined);
        const runs = await comparableRuns(this.host.metadata, this.host.environments, endpointId, endpoint);
        const run = runs.find(r => r.id === executionId);
        if (!run) {
            this.host.notify('warn', 'This result can go in a query once its run has finished.');
            return;
        }
        try {
            const adding = [{ endpointId, executionId: run.id, view: view || 'Root' }];
            const query = kind === 'add' ? getQuery(this.host.state, queryId ?? '') : await createQuery(this.host.state);
            if (!query) {
                this.host.notify('warn', 'That compare is no longer saved.');
                return;
            }
            if (kind === 'add' && query.sources.some(s => s.executionId === run.id && (s.view ?? '') === (view || 'Root'))) {
                this.host.notify('info', `${query.name} already has this result.`);
                await this.host.openCompare?.(query.id);
                return;
            }
            if (kind === 'compare') query.name = freeReportName(this.host.state, 'New compare', query.id);
            query.adding = [...(query.adding ?? []), ...adding];
            if (kind === 'compare') query.pickRun = true;
            await saveQuery(this.host.state, query);
            await this.host.openCompare?.(query.id);
        } catch (error) {
            this.host.notify('error', error instanceof Error ? error.message : String(error));
        }
    }

    private async postViews(): Promise<void> {
        const { endpointId } = this.host.getSourceRef();
        if (!endpointId) return;
        const endpoint = await this.host.endpoints?.getEndpoint(endpointId).catch(() => undefined) as { method?: string; path?: string } | undefined;
        const request = endpoint?.method && endpoint.path ? getEndpointViewScopeKey(endpoint.method, endpoint.path) : '';
        await this.host.post({ type: 'console.compareViews', payload: {
            views: viewsInCompares(this.host.state, endpointId),
            queries: viewsInQueries(this.host.state, { endpointId, request }),
            // (Add to Compare's list: the saved compares, newest first)
            compares: listQueries(this.host.state).filter(q => q.joins.some(j => j.kind === 'compare')).map(q => ({ id: q.id, name: q.name }))
        } });
    }
}
