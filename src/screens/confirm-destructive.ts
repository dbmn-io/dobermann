// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** "Are you sure?" with a danger-styled confirm, in a DbmnModal. True only when confirmed. */
import type { ModalHost } from './modal.types';

export interface ConfirmDestructiveOptions {
    title?: string;
    body: string;
    confirmLabel?: string;
    cancelLabel?: string;
}

export async function confirmDestructiveInModal(host: ModalHost, opts: ConfirmDestructiveOptions): Promise<boolean> {
    const result = await host.showModal({
        title: opts.title || 'Confirm',
        body: opts.body,
        actions: [
            { id: 'cancel', label: opts.cancelLabel || 'Cancel', variant: 'secondary' },
            { id: 'confirm', label: opts.confirmLabel || 'Delete', variant: 'danger' }
        ],
        dismissible: true,
        size: 'sm'
    });
    return result.actionId === 'confirm';
}
