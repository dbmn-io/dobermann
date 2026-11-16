// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Progress Adapter for Console Webview
 *
 * Intercepts VS Code progress.report() calls and routes them to console webview
 * instead of showing VS Code progress notifications.
 *
 * Issue #320: it reports through an `IExecutionProgressSink` instead of reaching into
 * `ConsoleWebviewManager`, so core that uses it loads no VS Code.
 */

import { CancellationFlag, IExecutionProgressSink } from '../../platform/interfaces/execution-progress-sink.interface';

export interface ProgressReportData {
    message?: string;
    increment?: number;
    /**
     * Issue #309: an explicit status wins over the one guessed from the
     * message text. The engine reports a queued batch as 'pending' so the
     * Console never starts its clock on a batch that isn't running.
     */
    status?: 'pending' | 'preparing' | 'running';
    /**
     * Genuinely waiting behind another batch. A batch also sits in 'pending'
     * while its first chunk is prepared — that is not a queue, and the
     * Console must not say "After the current batch" for it.
     */
    queued?: boolean;
    /** Issue #309: name of the batch this one is queued behind. */
    queuedBehind?: string;
    /** Issue #309: when the batch ahead is expected to finish (epoch ms). */
    expectedStartTime?: number;
    /** #344: what the batch is waiting for to come (e.g. DBMN for VS Code), not a batch ahead. */
    waitingFor?: string;
    /**
     * #344: the batch was running when it began to wait (VS Code closed mid-run): `startTime` is
     * then its run's, and the Console holds the clock there rather than starting it again.
     */
    midRun?: boolean;
    startTime?: number;
}

export interface ProgressToConsoleOptions {
    title?: string;
    cancellable?: boolean;
    /**
     * Issue #309: status of the very first progress message. A batch that
     * will wait for another used to open with "Starting..." (parsed as
     * running), so its Console timer ran from the moment it was queued.
     */
    initialStatus?: 'pending';
}

/**
 * Adapter that mimics VS Code's progress interface but sends to console webview
 */
export class ProgressToConsoleAdapter {
    private executionId: string;
    private title: string;
    private cancellable: boolean;
    private readonly cancellation = { isCancellationRequested: false };
    private totalProgress: number = 0;
    private startTime: number;
    private readonly initialStatus?: 'pending';

    constructor(
        executionId: string,
        private readonly sink: IExecutionProgressSink,
        options: ProgressToConsoleOptions = {}
    ) {
        this.executionId = executionId;
        this.title = options.title || 'Execution Progress';
        this.cancellable = options.cancellable || false;
        this.startTime = Date.now();
        this.initialStatus = options.initialStatus;
    }

    /**
     * Execute progress callback with our adapter (mimics vscode.window.withProgress)
     */
    async withProgress<T>(
        progressCallback: (progress: { report: (data: ProgressReportData) => void }, token: CancellationFlag) => Promise<T>
    ): Promise<T> {
        // Create progress interface that sends to console
        const progressInterface = {
            report: (data: ProgressReportData) => {
                this.sendProgressToConsole(data);
            }
        };

        // Open console if not already open
        await this.sink.ensureConsoleOpen(this.executionId);

        // Send initial progress state. A queued batch says so from the start
        // (Issue #309) instead of "Starting..." — which the Console read as
        // running and timed.
        this.sendProgressToConsole(this.initialStatus === 'pending'
            ? { message: 'Queued', status: 'pending', queued: true, increment: 0 }
            : { message: 'Starting...', increment: 0 });

        try {
            // Execute the progress callback
            return await progressCallback(progressInterface, this.cancellation);
        } finally {
            // Don't send completion message that could affect console status
            // Progress just stops - the main console status comes from execution metadata
        }
    }

    /**
     * Send progress update to report webview
     */
    private sendProgressToConsole(data: ProgressReportData): void {
        try {
            // Update total progress with proper rounding to avoid floating point precision issues
            if (data.increment) {
                this.totalProgress = Math.min(100, Math.round((this.totalProgress + data.increment) * 100) / 100);
            }

            if (!this.sink.hasConsole(this.executionId)) {
                // No console open - progress updates will be dropped
                return;
            }

            // Parse and enhance message with structured timing data; an
            // explicit status from the caller beats the guess (Issue #309)
            const enhancedData = this.parseAndEnhanceProgress(data.message || '', data.increment);
            if (data.status) {
                enhancedData.status = data.status;
            }

            this.sink.progress(this.executionId, {
                executionId: this.executionId,
                title: this.title,
                message: data.message,
                totalProgress: this.totalProgress,
                // Simple timing data - frontend calculates everything
                status: enhancedData.status,
                current: enhancedData.current,
                total: enhancedData.total,
                percentage: enhancedData.percentage,
                startTime: data.startTime ?? this.startTime,
                estimatedEndTime: enhancedData.estimatedEndTime,
                queued: data.queued,
                midRun: data.midRun,
                queuedBehind: data.queuedBehind,
                expectedStartTime: data.expectedStartTime,
                waitingFor: data.waitingFor,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('[ProgressAdapter] Failed to send progress to console:', error);
        }
    }

    /**
     * Parse progress message to extract structured data
     */
    private parseProgressMessage(message: string): {
        current?: number;
        total?: number;
        phase: string;
    } {
        // Parse different message formats:
        // "Creating transaction 75 of 100"
        // "Processing transaction 67/100 - ETA: 5 min"
        // "Waiting in queue (position 2)... 45s elapsed"

        // Extract numbers like "75 of 100" or "67/100"
        const ofMatch = message.match(/(\d+)\s+of\s+(\d+)/);
        const slashMatch = message.match(/(\d+)\/(\d+)/);

        let current: number | undefined;
        let total: number | undefined;
        let phase = 'unknown';

        if (ofMatch) {
            current = parseInt(ofMatch[1]);
            total = parseInt(ofMatch[2]);
        } else if (slashMatch) {
            current = parseInt(slashMatch[1]);
            total = parseInt(slashMatch[2]);
        }

        // Determine phase
        if (message.toLowerCase().includes('creating') || message.toLowerCase().includes('preparing')) {
            phase = 'preparing';
        } else if (message.toLowerCase().includes('processing') || message.toLowerCase().includes('executing')) {
            phase = 'executing';
        } else if (message.toLowerCase().includes('queue') || message.toLowerCase().includes('waiting')) {
            phase = 'queued';
        } else if (message.toLowerCase().includes('paused')) {
            phase = 'paused';
        }
        // Note: Intentionally NOT setting 'completed' phase - progress updates should not affect main report status

        return { current, total, phase };
    }


    /**
     * Extract ETA from progress message
     */
    private extractETA(message: string): string | undefined {
        // Match patterns like "ETA 2 min", "Est: 2m 15s", ". ETA 30s"
        const etaMatch = message.match(/(?:ETA[:\s]+|Est:\s*|\.?\s*ETA\s+)([^,\n|]+)/i);
        return etaMatch ? etaMatch[1].trim() : undefined;
    }

    /**
     * Extract ETA from message and convert to seconds
     */
    private extractEtaInSeconds(message: string): number | undefined {
        const etaText = this.extractETA(message);
        if (!etaText) return undefined;

        return this.parseTimeToSeconds(etaText);
    }

    /**
     * Parse time string to seconds (supports formats like "2 min", "1m 23s", "30s", "1h 15m")
     */
    private parseTimeToSeconds(timeText: string): number | undefined {
        if (!timeText) return undefined;

        // Parse formats like "2 min", "1m 23s", "30s", "1h 15m"
        let totalSeconds = 0;

        // Match hours
        const hoursMatch = timeText.match(/(\d+)h/);
        if (hoursMatch) {
            totalSeconds += parseInt(hoursMatch[1]) * 3600;
        }

        // Match minutes
        const minutesMatch = timeText.match(/(\d+)m/);
        if (minutesMatch) {
            totalSeconds += parseInt(minutesMatch[1]) * 60;
        }

        // Match seconds
        const secondsMatch = timeText.match(/(\d+)s/);
        if (secondsMatch) {
            totalSeconds += parseInt(secondsMatch[1]);
        }

        // Handle "2 min" format (without 'm')
        if (!hoursMatch && !secondsMatch && timeText.includes('min')) {
            const minMatch = timeText.match(/(\d+)\s*min/);
            if (minMatch) {
                totalSeconds += parseInt(minMatch[1]) * 60;
            }
        }

        return totalSeconds > 0 ? totalSeconds : undefined;
    }

    /**
     * Parse and enhance progress message with structured timing data
     */
    private parseAndEnhanceProgress(message: string, increment?: number): any {
        const payload: any = { message };

        // Determine status from message content
        if (message.toLowerCase().includes('preparing')) {
            payload.status = 'preparing';
        } else if (message.toLowerCase().includes('runtime:') || message.toLowerCase().includes('executing')) {
            payload.status = 'running';
        } else if (message.toLowerCase().includes('queue') || message.toLowerCase().includes('waiting')) {
            payload.status = 'pending';
        } else {
            payload.status = 'running';
        }

        // Extract current/total progress
        const countMatch = message.match(/(\d+)\/(\d+)/);
        if (countMatch) {
            payload.current = parseInt(countMatch[1]);
            payload.total = parseInt(countMatch[2]);
            payload.percentage = Math.round((payload.current / payload.total) * 100);
        }

        // Calculate estimated end time if ETA is provided
        const etaSeconds = this.extractEtaInSeconds(message);
        if (etaSeconds) {
            payload.estimatedEndTime = Date.now() + (etaSeconds * 1000);
        }

        return payload;
    }

    /**
     * Cancel the execution
     */
    cancel(): void {
        this.cancellation.isCancellationRequested = true;
    }

    /**
     * Check if cancelled
     */
    get isCancelled(): boolean {
        return this.cancellation.isCancellationRequested;
    }
}