// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: Chain and Links, the Console's host side.
 *
 *  - console.chain         — Chain pressed: take the Completed tab's rows (view + search, raw
 *                            values, no row limit), map them against every endpoint, and send the
 *                            page what its Chain dialog needs (console.chainOptions).
 *  - console.chainConfirm  — the user picked an endpoint: build the CSV and open Run Batch with it.
 *  - console.getLinks      — the Links tab: runs this one came from and fed, with differences.
 *  - console.openLinkedRun — a Links hyperlink: open that run's Console.
 *
 * Kept out of console-webview-manager.ts (over the Architecture.md file-size limit); the manager
 * only routes. Ranking and mapping are in services/chain (pure).
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { EnvironmentManager } from '../../environmentManager';
import { ColumnDefinition } from '../../types/console-messages';
import { rankChainTargets, ChainTargetCandidate, MAX_SUGGESTIONS, isSuggested } from '../../services/chain/chain-target-ranker';
import { ChainHandoff, ExecutionLinks, ExecutionLinkEnd } from '../../services/chain/chain-types';
import { linkDifferences, RunContext } from '../../services/chain/link-differences';
import { endpointInputVariables } from '../../services/chain/endpoint-input-variables';

export interface ChainRowsRequest {
    tab: 'input' | 'success' | 'errors';
    visibleColumnIds?: string[] | null;
    currentPath?: string;
    searchTerm?: string;
    view?: { name?: string } & Record<string, unknown>;
}

export interface ConsoleChainHost {
    getTabRowsForChain(request: ChainRowsRequest): Promise<{ data: any[]; columns: ColumnDefinition[] } | null>;
    getChainSourceRef(): { executionId?: string; endpointId?: string };
    toCsv(data: any[], columns: ColumnDefinition[]): Promise<string>;
    post(message: Record<string, unknown>): Promise<void>;
    notify(level: 'info' | 'warn' | 'error', message: string): void;
    /** Run history: the run and its links. */
    store?: {
        getExecution?(id: string): Promise<unknown>;
        getExecutionLinks?(id: string): Promise<unknown>;
    };
    endpoints: Pick<APIEndpointManager, 'getAllEndpoints' | 'getEndpoint'>;
    environments: Pick<EnvironmentManager, 'getActiveEnvironment'>;
    openConsole(executionId: string, isBatch: boolean): Promise<void>;
    openRunBatch(endpoint: APIEndpointConfig, chain: ChainHandoff): Promise<void>;
}

/** What the page's Chain dialog renders. Pure data; built by buildChainOptions. */
export interface ChainOptions {
    token: string;
    /** "GET Low Stock Report" — the dialog's title says where the rows come from. */
    sourceEndpoint?: string;
    rowCount: number;
    viewName?: string;
    searchTerm?: string;
    warnings: string[];
    /** The CSV's columns, in order — the preview lists every one, used or not. */
    columns: string[];
    firstRow: Record<string, string>;
    suggestedIds: string[];
    candidates: Array<Pick<ChainTargetCandidate, 'endpointId' | 'name' | 'method' | 'path' | 'variables' | 'matched' | 'missingRequired' | 'fullyCovered' | 'sameResource' | 'variableCount'>>;
}

interface PendingChain {
    token: string;
    executionId: string;
    rows: { data: any[]; columns: ColumnDefinition[] };
    viewName?: string;
    sourceLabel: string;
    sourceIsBatch: boolean;
}

export class ConsoleChainHandler {
    private pending: PendingChain | undefined;

    constructor(private readonly host: ConsoleChainHost) {}

    /** Returns true when the message was ours. */
    async handle(message: { type: string; payload?: any }): Promise<boolean> {
        switch (message.type) {
            case 'console.chain':
                await this.prepare(message.payload as ChainRowsRequest);
                return true;
            case 'console.chainConfirm':
                await this.confirm(message.payload as { token: string; endpointId: string });
                return true;
            case 'console.getLinks':
                await this.sendLinks();
                return true;
            case 'console.openLinkedRun': {
                const { executionId, isBatch } = (message.payload || {}) as { executionId?: string; isBatch?: boolean };
                if (executionId) {
                    await this.host.openConsole(executionId, !!isBatch);
                }
                return true;
            }
            default:
                return false;
        }
    }

    async sendLinks(): Promise<void> {
        const { executionId } = this.host.getChainSourceRef();
        let links: ExecutionLinks = { upstream: [], downstream: [] };
        let status = '';
        const store = this.host.store as any;
        if (executionId && store) {
            try {
                if (typeof store.getExecutionLinks === 'function') links = await store.getExecutionLinks(executionId);
                const self = typeof store.getExecution === 'function' ? await store.getExecution(executionId) : null;
                status = String(self?.status || '').toLowerCase();
            } catch {
                // No links is the right answer when the store cannot say.
            }
        }
        // Traceability: where each linked run differs from this one (a warning only).
        const self: RunContext = links.self || {};
        const ctx = (end: ExecutionLinkEnd): RunContext => ({ environment: end.environment, organization: end.organization, headers: end.headers });
        const strip = (end: ExecutionLinkEnd, from: RunContext, to: RunContext): ExecutionLinkEnd => {
            const { headers: _headers, organization: _org, ...rest } = end;   // header values stay on the host
            return { ...rest, differences: linkDifferences(from, to) };
        };
        await this.host.post({
            type: 'console.links',
            payload: {
                executionId,
                status,
                upstream: links.upstream.map(end => strip(end, ctx(end), self)),       // rows came from end → this run
                downstream: links.downstream.map(end => strip(end, self, ctx(end)))    // this run → rows went to end
            }
        });
    }

    private async prepare(request: ChainRowsRequest): Promise<void> {
        const { executionId, endpointId } = this.host.getChainSourceRef();
        const store = this.host.store as any;
        const source = executionId && store?.getExecution ? await store.getExecution(executionId) : null;
        if (!executionId || String(source?.status || '').toLowerCase() !== 'completed') {
            this.host.notify('warn', 'Chain is available once the run has completed.');
            return;
        }
        const rows = await this.host.getTabRowsForChain({ ...request, tab: 'success' });
        if (!rows || rows.data.length === 0) {
            this.host.notify('warn', 'There are no rows to chain. Clear the search, or pick a view with rows.');
            return;
        }

        const endpointManager = this.host.endpoints as any;
        const environmentManager = this.host.environments as any;
        const endpoints = endpointManager?.getAllEndpoints ? await endpointManager.getAllEndpoints() : [];
        const sourceEndpoint = endpointId && endpointManager?.getEndpoint ? await endpointManager.getEndpoint(endpointId) : undefined;
        const active = environmentManager?.getActiveEnvironment ? await environmentManager.getActiveEnvironment() : undefined;

        const sourceEnvironment: string = source?.environment || '';
        const warnings: string[] = [];
        const sameEnvironment = !active || (source?.environmentId && active.id ? source.environmentId === active.id : sourceEnvironment === active.name);
        if (!sameEnvironment) {
            warnings.push(`Rows came from ${sourceEnvironment || 'another environment'}. Run Batch sends to ${active.name}, the active environment.`);
        }
        const activeOrg = active?.variables?.org;
        if (activeOrg && source?.organization && activeOrg !== source.organization) {
            warnings.push(`Rows came from organization ${source.organization}. The active organization is ${activeOrg}.`);
        }

        const token = `chain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const method = String(source?.endpointMethod || sourceEndpoint?.method || '').toUpperCase();
        this.pending = {
            token,
            executionId,
            rows,
            viewName: request.view?.name,
            sourceLabel: [`${method} ${source?.endpointName || sourceEndpoint?.name || ''}`.trim(), sourceEnvironment].filter(Boolean).join(' · '),
            sourceIsBatch: source?.executionType === 'batch'
        };

        const options = buildChainOptions({
            token,
            rows,
            endpoints,
            source: { id: endpointId, method: method || undefined, path: source?.endpointPath || sourceEndpoint?.path },
            viewName: request.view?.name,
            searchTerm: request.searchTerm,
            warnings,
            sourceEndpoint: `${method} ${source?.endpointName || sourceEndpoint?.name || ''}`.trim()
        });
        if (options.candidates.length === 0) {
            this.host.notify('warn', 'There is no other endpoint to chain to. Add one in Endpoints first.');
            return;
        }
        await this.host.post({ type: 'console.chainOptions', payload: options });
    }

    private async confirm(payload: { token: string; endpointId: string }): Promise<void> {
        const pending = this.pending;
        if (!pending || !payload || payload.token !== pending.token) return;
        const endpointManager = this.host.endpoints as any;
        const target = endpointManager?.getEndpoint ? await endpointManager.getEndpoint(payload.endpointId) : undefined;
        if (!target) return;
        // An endpoint with no variables has nothing for the rows to fill (the dialog disables Chain too).
        if (endpointInputVariables(target).length === 0) {
            this.host.notify('warn', `${target.name} has no variables in its URL, query parameters, headers or body. There is nothing for the rows to fill.`);
            return;
        }
        this.pending = undefined;

        const handoff: ChainHandoff = {
            csv: await this.host.toCsv(pending.rows.data, pending.rows.columns),
            rowCount: pending.rows.data.length,
            sourceExecutionId: pending.executionId,
            sourceIsBatch: pending.sourceIsBatch,
            sourceLabel: pending.sourceLabel,
            viewName: pending.viewName
        };
        await this.host.openRunBatch(target, handoff);
    }
}

function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/** Pure: everything the page's Chain dialog needs. Exported for tests. */
export function buildChainOptions(input: {
    token: string;
    rows: { data: any[]; columns: ColumnDefinition[] };
    endpoints: any[];
    source: { id?: string; method?: string; path?: string };
    viewName?: string;
    searchTerm?: string;
    warnings?: string[];
    sourceEndpoint?: string;
}): ChainOptions {
    const names = input.rows.columns.map(c => c.name);
    const ranked = rankChainTargets(names, input.endpoints, input.source);
    const first = input.rows.data[0] || {};
    const firstRow: Record<string, string> = {};
    for (const column of input.rows.columns) firstRow[column.name] = cellText(first[column.id]);
    return {
        token: input.token,
        sourceEndpoint: input.sourceEndpoint,
        rowCount: input.rows.data.length,
        viewName: input.viewName,
        searchTerm: input.searchTerm || undefined,
        warnings: input.warnings || [],
        columns: names,
        firstRow,
        suggestedIds: ranked.filter(isSuggested).slice(0, MAX_SUGGESTIONS).map(c => c.endpointId),
        candidates: ranked.map(c => ({
            endpointId: c.endpointId, name: c.name, method: c.method, path: c.path,
            variables: c.variables, matched: c.matched, missingRequired: c.missingRequired,
            fullyCovered: c.fullyCovered, sameResource: c.sameResource, variableCount: c.variableCount
        }))
    };
}
