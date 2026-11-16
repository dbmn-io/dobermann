// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Startup recovery (GitHub Issue #313).
 *
 * VS Code was closed, or crashed, with work in flight. On the next activation
 * nothing is running any more, but the records still say so. This puts them
 * into states the user can act on:
 *
 *   batch, running          → paused   (resumable from its Console)
 *   batch, pending (queued) → paused   (it was waiting its turn; it can be resumed too)
 *   batch member, running   → pending  (its batch picks it up on resume)
 *   individual, running or pending → cancelled (a single call: run it again)
 *
 * It returns what it did so the Hub can say so. It never asks the user
 * anything — the old recovery awaited a native notification inside
 * activation, which held the Hub closed until it was answered — and it is
 * portable: no `vscode.*`.
 */

import { IExecutionMetadataService } from './execution-metadata.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';

export interface RecoveredBatch {
    id: string;
    name: string;
    /** It was queued behind another batch, not running, when the host went away. */
    wasQueued: boolean;
}

export interface StartupRecoverySummary {
    batches: RecoveredBatch[];
    membersReset: number;
    individualsCancelled: number;
    errors: string[];
}

export class StartupRecoveryService {
    constructor(
        private readonly metadata: Pick<IExecutionMetadataService, 'getAllTransactions' | 'updateExecution'>,
        private readonly logger: IExtensionDiagnosticLogger
    ) {}

    /** True when there was nothing to recover. */
    static isEmpty(summary: StartupRecoverySummary | undefined): boolean {
        return !summary || (summary.batches.length === 0 && summary.membersReset === 0 && summary.individualsCancelled === 0);
    }

    async recover(): Promise<StartupRecoverySummary> {
        const summary: StartupRecoverySummary = { batches: [], membersReset: 0, individualsCancelled: 0, errors: [] };
        const all = await this.metadata.getAllTransactions();
        const now = new Date();

        for (const execution of all) {
            const status = String(execution.status || '').toLowerCase();
            const type = execution.executionType;
            try {
                if (type === 'batch' && (status === 'running' || status === 'pending')) {
                    const wasQueued = status === 'pending';
                    await this.metadata.updateExecution(execution.id, {
                        status: 'paused',
                        pausedAt: now,
                        pauseReason: wasQueued
                            ? 'Queued when VS Code closed — resume to run it'
                            : 'Running when VS Code closed — resume to continue'
                    } as Partial<typeof execution>);
                    summary.batches.push({ id: execution.id, name: execution.endpointName || execution.id, wasQueued });
                } else if (type === 'batch_member' && status === 'running') {
                    await this.metadata.updateExecution(execution.id, { status: 'pending', startedAt: undefined });
                    summary.membersReset++;
                } else if (type === 'individual' && (status === 'running' || status === 'pending')) {
                    await this.metadata.updateExecution(execution.id, {
                        status: 'cancelled',
                        completedAt: now,
                        errorMessage: 'Cancelled: VS Code closed while it was running'
                    });
                    summary.individualsCancelled++;
                }
            } catch (error) {
                const message = `${execution.id}: ${error instanceof Error ? error.message : String(error)}`;
                summary.errors.push(message);
                this.logger.error(`[StartupRecovery] issue#313 failed to recover ${message}`, error instanceof Error ? error : undefined);
            }
        }

        if (!StartupRecoveryService.isEmpty(summary)) {
            this.logger.info(`[StartupRecovery] issue#313 paused ${summary.batches.length} batch(es) (${summary.batches.filter(b => b.wasQueued).length} queued), reset ${summary.membersReset} member(s), cancelled ${summary.individualsCancelled} individual(s)`);
        }
        return summary;
    }

    /**
     * The one line the Hub shows: "Found 2 batches running or queued when VS Code
     * closed: "Orders", "Inventory". They've been paused — resume them when you're ready."
     */
    static describe(summary: StartupRecoverySummary): string {
        const parts: string[] = [];
        const batches = summary.batches;
        if (batches.length) {
            const queued = batches.filter(b => b.wasQueued).length;
            const what = queued === 0 ? 'running' : queued === batches.length ? 'queued' : 'running or queued';
            const names = batches.slice(0, 3).map(b => `"${b.name}"`).join(', ') + (batches.length > 3 ? ` and ${batches.length - 3} more` : '');
            parts.push(`Found ${batches.length === 1 ? 'a batch' : `${batches.length} batches`} ${what} when VS Code closed: ${names}. ` +
                `${batches.length === 1 ? "It's" : "They've"} been paused — resume ${batches.length === 1 ? 'it' : 'them'} when you're ready.`);
        }
        if (summary.individualsCancelled) {
            parts.push(`${summary.individualsCancelled} single request${summary.individualsCancelled === 1 ? ' was' : 's were'} cancelled — run again if needed.`);
        }
        return parts.join(' ');
    }
}
