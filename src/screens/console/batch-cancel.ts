// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #335: Cancel on a running batch cuts off the requests in flight, which may or may not have
 * reached the API, so it asks first and offers Pause (which lets them finish). Paused, stopped
 * or still queued, nothing is in flight: no question. The Console footer and History's
 * right-click menu both ask through this, in every host.
 */
import type { DbmnModalResult, DbmnModalSpec } from '../modal.types';

export const CANCEL_BATCH_QUESTION: DbmnModalSpec = {
    title: 'Cancel this batch?',
    body: 'The requests being sent right now are cut off. They may or may not have reached the API, and are marked Cancelled. Pause lets them finish first.\n\n'
        + 'Either way, Resume carries on from the next row.',
    actions: [
        { id: 'keep', label: 'Keep running', variant: 'secondary' },
        { id: 'pause', label: 'Pause instead', variant: 'secondary' },
        { id: 'cancel', label: 'Cancel batch', variant: 'danger' }
    ],
    dismissible: true,
    size: 'sm'
};

export type BatchCancelChoice = 'cancel' | 'pause' | 'keep';

/** What to do with a Cancel on a batch in `status`. Closing the question keeps it running. */
export async function askBeforeCancellingBatch(
    status: string | undefined,
    showModal: (spec: DbmnModalSpec) => Promise<DbmnModalResult>
): Promise<BatchCancelChoice> {
    if (!['running', 'executing'].includes(String(status ?? '').toLowerCase())) return 'cancel';
    const { actionId } = await showModal(CANCEL_BATCH_QUESTION);
    return actionId === 'cancel' || actionId === 'pause' ? actionId : 'keep';
}
