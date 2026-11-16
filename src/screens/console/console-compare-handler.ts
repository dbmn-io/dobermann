// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare, the Console's host side. A compare starts here, from the Completed tab,
 * through the View the tab shows: this result is the Baseline.
 *
 *  - console.compare         — Compare pressed: a draft of the compare with this result as its
 *                              Baseline, opened in Compare on its Select step (which picks the
 *                              results to compare with it).
 *  - console.compareViews    — the endpoint's Views that saved compares read (the View list
 *                              flags them, and editing one warns).
 *
 * Kept out of console.controller.ts (over the Architecture.md file-size limit); it only routes.
 */
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import { comparableRuns, RequestTemplates } from '../../services/compare/compare-runs';
import { createDraft, viewsInCompares, CompareState } from '../../services/compare/compare-store';

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
        const payload = (message.payload ?? {}) as { view?: string };
        switch (message.type) {
            case 'console.compare': await this.start(payload.view); return true;
            case 'console.compareViews': await this.postViews(); return true;
            default: return false;
        }
    }

    /** This result as the Baseline of a draft compare, opened on Select. */
    private async start(view: string | undefined): Promise<void> {
        const { executionId, endpointId } = this.host.getSourceRef();
        if (!executionId || !endpointId) {
            this.host.notify('warn', 'Compare needs a saved endpoint. Save this endpoint, then run it again.');
            return;
        }
        const endpoint = await this.host.endpoints?.getEndpoint(endpointId).catch(() => undefined);
        const runs = await comparableRuns(this.host.metadata, this.host.environments, endpointId, endpoint);
        const run = runs.find(r => r.id === executionId);
        if (!run) {
            this.host.notify('warn', 'Compare can start once this run has finished.');
            return;
        }
        try {
            const draft = await createDraft(this.host.state, {
                kind: 'result', endpointId, view: view || 'Root', executionId: run.id, isBatch: run.isBatch, environment: run.environment, executedAt: run.executedAt,
                ...(run.header ? { header: run.header } : {}),
            });
            await this.host.openCompare?.(draft.id);
        } catch (error) {
            this.host.notify('error', error instanceof Error ? error.message : String(error));
        }
    }

    private async postViews(): Promise<void> {
        const { endpointId } = this.host.getSourceRef();
        if (!endpointId) return;
        await this.host.post({ type: 'console.compareViews', payload: { views: viewsInCompares(this.host.state, endpointId) } });
    }
}
