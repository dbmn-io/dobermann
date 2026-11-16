// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #342: keep a host's catalogue in step with changes made elsewhere (the web app, another VS
 * Code), the same way in both hosts. Realtime announces a change; a moment later (changes come
 * in bursts) the catalogue reloads and the host refreshes its screens. Once subscribed, one
 * reload catches anything changed between the load and the subscription.
 */
import type { CatalogChange } from './catalog-store.interface';
import type { Event } from '../../platform/events';
import type { CatalogueState } from './catalogue-state';

export interface LiveCatalogue {
    /** Resolves once Realtime is listening, or has failed (logged; reloads then wait for sign-in). */
    readonly ready: Promise<void>;
    dispose(): void;
}

export function followCatalogueChanges(
    store: { readonly onChanged: Event<CatalogChange>; connect(): Promise<void> },
    state: Pick<CatalogueState, 'reload'> & Partial<Pick<CatalogueState, 'isOwnWrite'>>,
    host: { onReloaded(): void; log(message: string, error?: unknown): void },
    delayMs = 300
): LiveCatalogue {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            state.reload()
                .then(() => { if (!disposed) host.onReloaded(); })
                .catch(error => host.log('[Catalogue] reload failed', error));
        }, delayMs);
    };
    // Our own saves are announced too (so their Realtime echo is known): they are in memory
    // already, and need no reload. Only changes made elsewhere do.
    const changes = store.onChanged(change => { if (!state.isOwnWrite?.(change)) schedule(); });
    const ready = store.connect()
        .then(() => {
            host.log('[Catalogue] listening for changes made elsewhere');
            schedule();
        })
        .catch(error => host.log('[Catalogue] Realtime unavailable: changes made elsewhere show after a reload', error));
    return {
        ready,
        dispose() {
            disposed = true;
            clearTimeout(timer);
            changes.dispose();
        }
    };
}
