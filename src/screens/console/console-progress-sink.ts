// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #320: the engine's progress, delivered to open Consoles (ConsoleController's live
 * registry). Any host: opening a Console is the host's (a Hub tab).
 */
import {
    ConsoleConcurrencyUpdate,
    ConsoleEtaUpdate,
    ConsoleMemberResult,
    ConsoleProgressPayload,
    ConsoleStatusUpdate,
    IExecutionProgressSink,
    MemberEndpointInfo
} from '../../platform/interfaces/execution-progress-sink.interface';
import { ConsoleController } from './console.controller';

export class ConsoleProgressSink implements IExecutionProgressSink {
    constructor(private readonly open: (executionId: string, options: { isBatch: boolean; focus?: boolean }) => Promise<void>) {}

    openConsole(executionId: string, options: { isBatch: boolean; focus?: boolean }): Promise<void> {
        return this.open(executionId, options);
    }

    async ensureConsoleOpen(executionId: string): Promise<void> {
        try {
            if (!this.hasConsole(executionId)) {
                await this.openConsole(executionId, { isBatch: true });
                // A moment for the Console to be created and registered
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            console.error('[ProgressAdapter] Failed to open console:', error);
        }
    }

    hasConsole(executionId: string): boolean {
        return ConsoleController.hasConsole(executionId);
    }

    progress(executionId: string, payload: ConsoleProgressPayload): void {
        // No Console open: dropped
        ConsoleController.postTo(executionId, { type: 'progress_update', payload });
    }

    eta(executionId: string, update: ConsoleEtaUpdate): Promise<void> {
        return ConsoleController.sendProgressUpdate(executionId, update);
    }

    status(executionId: string, update: ConsoleStatusUpdate): Promise<void> {
        return ConsoleController.sendStatusUpdate(executionId, update);
    }

    memberStatus(batchId: string, executionIds: string[], status: string, memberIndices?: Record<string, number>, memberEndpointInfo?: MemberEndpointInfo): Promise<void> {
        return ConsoleController.sendMemberStatusUpdate(batchId, executionIds, status, memberIndices, memberEndpointInfo);
    }

    memberResult(batchId: string, update: ConsoleMemberResult): Promise<void> {
        return ConsoleController.sendMemberResultUpdate(batchId, update);
    }

    concurrency(batchId: string, update: ConsoleConcurrencyUpdate): Promise<void> {
        return ConsoleController.sendConcurrencyUpdate(batchId, update);
    }
}
