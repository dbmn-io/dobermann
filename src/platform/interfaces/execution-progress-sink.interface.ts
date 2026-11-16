// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #320: where execution progress goes. Core (the batch engine, transaction preparation,
 * the progress adapter) reports through this port and never imports the Console. The VS Code
 * shell forwards to `ConsoleWebviewManager` exactly as the engine used to
 * (`platform/vscode/vscode-console-progress-sink.ts`); `test:core` records the calls
 * (`platform/memory/recording-progress-sink.ts`).
 *
 * Provisional and engine-shaped on purpose: one method per message the engine sent the Console
 * before this port existed. The cross-surface message bus (#328) is designed separately.
 * Everything here stays in-process; nothing leaves the machine.
 */

/** Live status of an execution, as the Console's header and totals show it. */
export interface ConsoleStatusUpdate {
    status: string;
    statusDisplay?: string;
    errorMessage?: string;
    durationSeconds?: number;
    startTime?: number;
    responseData?: unknown;
    progress?: {
        completed: number;
        total: number;
        percentage: number;
    };
    responseFile?: string;
    requestFile?: string;
    // GitHub Issue #151: Reprocess tracking fields
    reprocessedToBatchId?: string;
    reprocessedFromBatchId?: string;
    // Force data reload (e.g. after split changes member list)
    forceReload?: boolean;
}

/** The engine's periodic ETA update for a running batch. */
export interface ConsoleEtaUpdate {
    status: string;
    current?: number;
    total?: number;
    startTime: number;
    estimatedEndTime: number | null;
    message?: string;
}

/** A progress report from `ProgressToConsoleAdapter` (preparation, splitting, queue waits). */
export interface ConsoleProgressPayload {
    executionId: string;
    title: string;
    message?: string;
    totalProgress: number;
    status?: string;
    current?: number;
    total?: number;
    percentage?: number;
    startTime: number;
    estimatedEndTime?: number;
    queued?: boolean;
    queuedBehind?: string;
    expectedStartTime?: number;
    /** #344: waiting for something to come (DBMN for VS Code), not for a batch ahead. */
    waitingFor?: string;
    /** #344: it was running when it began to wait (VS Code closed mid-run): the clock holds at `startTime`. */
    midRun?: boolean;
    timestamp: number;
    /** Issue #115: a response body still arriving. The Console shows it without touching the run's clock. */
    receiving?: { bytes: number; lines: number; totalBytes?: number; totalRecords?: number; jsonl: boolean; done: boolean };
}

export interface ConsoleMemberResult {
    /** The member's RawResponse, as read back from its response file. */
    result: unknown;
    classification: 'success' | 'errors';
    memberIndex: number;
    totalMembers: number;
}

export interface ConsoleConcurrencyUpdate {
    currentConcurrency: number;
    maxConcurrency: number;
    oldConcurrency?: number;
    projectedEtaMs?: number | null;
}

export type MemberEndpointInfo = Record<string, {
    endpointPath?: string;
    requestHeaders?: Record<string, string>;
    requestQueryParams?: Record<string, string>;
}>;

export interface IExecutionProgressSink {
    /** Open (or, with `focus`, bring forward) the Console for an execution. `focus: false`: a
     *  Console already open isn't brought forward. Rejects if it cannot. */
    openConsole(executionId: string, options: { isBatch: boolean; focus?: boolean }): Promise<void>;
    /** Open a batch Console only if none is open for it yet. Never rejects. */
    ensureConsoleOpen(executionId: string): Promise<void>;
    /** Whether a Console is listening for this execution. */
    hasConsole(executionId: string): boolean;

    progress(executionId: string, payload: ConsoleProgressPayload): void;
    eta(executionId: string, update: ConsoleEtaUpdate): Promise<void>;
    status(executionId: string, update: ConsoleStatusUpdate): Promise<void>;
    memberStatus(
        batchId: string,
        executionIds: string[],
        status: string,
        memberIndices?: Record<string, number>,
        memberEndpointInfo?: MemberEndpointInfo
    ): Promise<void>;
    memberResult(batchId: string, update: ConsoleMemberResult): Promise<void>;
    concurrency(batchId: string, update: ConsoleConcurrencyUpdate): Promise<void>;
}

/**
 * The part of `vscode.CancellationToken` core reads. Structural, so a VS Code token still fits.
 */
export interface CancellationFlag {
    readonly isCancellationRequested: boolean;
}

/** For a core service constructed without a sink: progress is dropped, as with no Console open. */
export const NO_PROGRESS_SINK: IExecutionProgressSink = {
    openConsole: async () => undefined,
    ensureConsoleOpen: async () => undefined,
    hasConsole: () => false,
    progress: () => undefined,
    eta: async () => undefined,
    status: async () => undefined,
    memberStatus: async () => undefined,
    memberResult: async () => undefined,
    concurrency: async () => undefined
};
