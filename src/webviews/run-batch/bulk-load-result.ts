// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What comes back from starting a batch, and what Run Batch does when it did not start.
 *
 * GitHub Issue #396: `dbmn.internal.executeBulkLoad` catches everything and answers
 * `{ success: false }`. Run Batch never read that answer, so a batch failing in preparation
 * left the tab on "Preparing batch execution…" for ever with nothing on screen. The answer
 * has to be a value, not a thrown error: VS Code re-wraps what a command throws, so an
 * `instanceof` check does not survive `executeCommand`.
 *
 * A batch is refused only by the user
 * stopping at a prompt (the environment's own sign-in) or by a real failure.
 *
 * Portable: no `vscode` import. The webview passes in what it can do (BatchStartFailureHost).
 */
import { RunCancelledError } from '../../errors/run-cancelled-error';

export interface BulkLoadResult {
    success: boolean;
    message: string;
    /** The user closed a prompt, or has to finish signing in first. Not an error. */
    cancelled?: boolean;
}

/** The start command's answer for anything it caught. */
export function bulkLoadFailure(error: unknown): BulkLoadResult {
    if (error instanceof RunCancelledError) {
        return { success: false, message: error.message, cancelled: true };
    }
    return { success: false, message: error instanceof Error ? error.message : String(error) };
}

export interface BatchStartFailure {
    /** 'cancelled': the user stopped at a prompt. 'error': anything else. */
    kind: 'cancelled' | 'error';
    message: string;
}

/** null when the batch started. */
export function describeBatchStartFailure(result: unknown): BatchStartFailure | null {
    if (!result || typeof result !== 'object' || (result as BulkLoadResult).success !== false) {
        return null;
    }
    const { message, cancelled } = result as BulkLoadResult;
    if (cancelled) {
        return { kind: 'cancelled', message };
    }
    return { kind: 'error', message: message || 'The batch could not be started.' };
}

/** What the Run Batch webview can do about a failure. */
export interface BatchStartFailureHost {
    /** The Batch tab is still open. */
    hasPanel(): boolean;
    postToPage(message: { type: 'bulkLoadCommandExecuted'; error: string } | { type: 'resetExecuteButton' }): void;
}

/**
 * Tell the user. The tab stays open and Execute comes back, so the batch can be run again
 * once the cause is dealt with. With the tab already gone the batch got as far as its
 * Console, which shows ordinary failures itself.
 */
export async function reportBatchStartFailure(failure: BatchStartFailure, host: BatchStartFailureHost): Promise<void> {
    if (!host.hasPanel()) return;
    if (failure.kind === 'cancelled') {
        // The prompt the user closed (or the sign-in they started) already said everything.
        host.postToPage({ type: 'resetExecuteButton' });
        return;
    }
    host.postToPage({ type: 'bulkLoadCommandExecuted', error: failure.message });
}
