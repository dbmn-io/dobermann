// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #335: how a batch resumes. The Console's Resume and History's right-click Resume ask the same
 * question and take the same steps, in every host: what to do on an error, whether to retry
 * the failed transactions, and whether to send again the ones Cancel cut off.
 */
import type { DbmnModalResult, DbmnModalSpec } from '../modal.types';

export interface ResumeChoice {
    stopOnFirstError: boolean;
    /** Retry the failed transactions first */
    retryFailed: boolean;
    /** Send again the transactions Cancel cut off */
    retryCutOff: boolean;
}

/** The engine's part in a resume, before it carries on. */
export interface ResumeSteps {
    resetErrorMembersToPending(batchId: string): Promise<number>;
    resetCancelledMembersToPending(batchId: string): Promise<number>;
    updateBatchErrorMode(batchId: string, config: { stopOnFirstError: boolean }): Promise<void>;
}

type ResumeBatch = { batchConfiguration?: { stopOnFirstError?: boolean } } | null | undefined;

/** The question. Failed and cut-off transactions are only asked about when there are some. */
export function resumeQuestion(batch: ResumeBatch, members: Array<{ status: string }>): DbmnModalSpec {
    const errorCount = members.filter(m => ['error', 'failed'].includes(m.status)).length;
    const pendingCount = members.filter(m => m.status === 'pending').length;
    // The transactions Cancel cut off (they may or may not have reached the API)
    const cutOffCount = members.filter(m => m.status === 'cancelled').length;

    const fields: DbmnModalSpec['fields'] = [
        {
            id: 'errorMode',
            type: 'radio',
            label: 'On error',
            value: batch?.batchConfiguration?.stopOnFirstError ? 'stop' : 'continue',
            options: [
                { value: 'continue', label: 'Continue' },
                { value: 'stop', label: 'Stop on error' }
            ]
        }
    ];
    if (errorCount > 0) {
        fields.push({
            id: 'retryFailed',
            type: 'radio',
            label: 'Failed transactions',
            value: 'no',
            options: [
                { value: 'yes', label: `Retry ${errorCount} failed` },
                { value: 'no', label: `Skip failed (${pendingCount} pending only)` }
            ]
        });
    }
    if (cutOffCount > 0) {
        fields.push({
            id: 'retryCutOff',
            type: 'radio',
            label: 'Cut-off transactions',
            // Send again by default: a cut-off request most often never landed. The
            // option says it may have, for an API where a repeat would do it twice.
            value: 'yes',
            options: [
                { value: 'yes', label: `Send ${cutOffCount} again`, description: 'Cancel cut them off: they may or may not have reached the API' },
                { value: 'no', label: 'Skip them' }
            ]
        });
    }
    return {
        title: 'Resume Batch',
        fields,
        actions: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' },
            { id: 'resume', label: 'Resume', variant: 'primary' }
        ],
        dismissible: true,
        size: 'md'
    };
}

/** Asks how to resume. Undefined: the user closed it, nothing resumes. */
export async function askHowToResume(
    batch: ResumeBatch,
    members: Array<{ status: string }>,
    showModal: (spec: DbmnModalSpec) => Promise<DbmnModalResult>
): Promise<ResumeChoice | undefined> {
    const spec = resumeQuestion(batch, members);
    const asked = new Set((spec.fields ?? []).map(f => f.id));
    const { actionId, fields } = await showModal(spec);
    if (actionId !== 'resume') return undefined;
    return {
        stopOnFirstError: fields.errorMode === 'stop',
        retryFailed: asked.has('retryFailed') && fields.retryFailed === 'yes',
        retryCutOff: asked.has('retryCutOff') && fields.retryCutOff === 'yes'
    };
}

/**
 * The choice, before the batch carries on: the failed and cut-off transactions it sends again
 * back to pending, and the error mode. `errorsReset`: an open Console drops the errors shown.
 */
export async function applyResumeChoice(
    engine: ResumeSteps,
    batchId: string,
    choice: ResumeChoice,
    errorsReset?: () => Promise<void>
): Promise<void> {
    if (choice.retryFailed) {
        await engine.resetErrorMembersToPending(batchId);
        await errorsReset?.();
    }
    if (choice.retryCutOff) await engine.resetCancelledMembersToPending(batchId);
    // GitHub Issue #151: always set, so the batch runs with what was asked
    await engine.updateBatchErrorMode(batchId, { stopOnFirstError: choice.stopOnFirstError });
}
