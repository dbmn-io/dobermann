// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #320: an `IExecutionProgressSink` that records every call in order, for `test:core`.
 * Consoles are "open" once `openConsole`/`ensureConsoleOpen` has been called for an id, or when
 * listed in `openConsoles` up front.
 */
import {
    ConsoleConcurrencyUpdate,
    ConsoleEtaUpdate,
    ConsoleMemberResult,
    ConsoleProgressPayload,
    ConsoleStatusUpdate,
    IExecutionProgressSink,
    MemberEndpointInfo
} from '../interfaces/execution-progress-sink.interface';

export type RecordedProgressEvent =
    | { kind: 'openConsole'; executionId: string; isBatch: boolean; focus: boolean }
    | { kind: 'progress'; executionId: string; payload: ConsoleProgressPayload }
    | { kind: 'eta'; executionId: string; update: ConsoleEtaUpdate }
    | { kind: 'status'; executionId: string; update: ConsoleStatusUpdate }
    | {
        kind: 'memberStatus';
        batchId: string;
        executionIds: string[];
        status: string;
        memberIndices?: Record<string, number>;
        memberEndpointInfo?: MemberEndpointInfo;
    }
    | { kind: 'memberResult'; batchId: string; update: ConsoleMemberResult }
    | { kind: 'concurrency'; batchId: string; update: ConsoleConcurrencyUpdate };

export class RecordingProgressSink implements IExecutionProgressSink {
    readonly events: RecordedProgressEvent[] = [];
    private readonly open: Set<string>;

    constructor(openConsoles: string[] = []) {
        this.open = new Set(openConsoles);
    }

    /** Recorded events of one kind, narrowed. */
    of<K extends RecordedProgressEvent['kind']>(kind: K): Extract<RecordedProgressEvent, { kind: K }>[] {
        return this.events.filter((event): event is Extract<RecordedProgressEvent, { kind: K }> => event.kind === kind);
    }

    async openConsole(executionId: string, options: { isBatch: boolean; focus?: boolean }): Promise<void> {
        this.open.add(executionId);
        this.events.push({ kind: 'openConsole', executionId, isBatch: options.isBatch, focus: options.focus === true });
    }

    async ensureConsoleOpen(executionId: string): Promise<void> {
        if (!this.open.has(executionId)) {
            await this.openConsole(executionId, { isBatch: true });
        }
    }

    hasConsole(executionId: string): boolean {
        return this.open.has(executionId);
    }

    progress(executionId: string, payload: ConsoleProgressPayload): void {
        this.events.push({ kind: 'progress', executionId, payload });
    }

    async eta(executionId: string, update: ConsoleEtaUpdate): Promise<void> {
        this.events.push({ kind: 'eta', executionId, update });
    }

    async status(executionId: string, update: ConsoleStatusUpdate): Promise<void> {
        this.events.push({ kind: 'status', executionId, update });
    }

    async memberStatus(
        batchId: string,
        executionIds: string[],
        status: string,
        memberIndices?: Record<string, number>,
        memberEndpointInfo?: MemberEndpointInfo
    ): Promise<void> {
        this.events.push({ kind: 'memberStatus', batchId, executionIds, status, memberIndices, memberEndpointInfo });
    }

    async memberResult(batchId: string, update: ConsoleMemberResult): Promise<void> {
        this.events.push({ kind: 'memberResult', batchId, update });
    }

    async concurrency(batchId: string, update: ConsoleConcurrencyUpdate): Promise<void> {
        this.events.push({ kind: 'concurrency', batchId, update });
    }
}
