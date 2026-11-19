// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One screen's conversation with its webview, shared by every screen in both hosts: posting,
 * DbmnModal round trips (including async `onSubmit` actions), external links and clipboard
 * requests. Moved from WebviewBase, which now delegates here, so VS Code and the web app run
 * the same protocol code.
 */
import { DbmnModalResult, DbmnModalSpec, ModalHost, ModalWait } from './modal.types';

/** Where messages to the screen go: a VS Code webview panel, or an iframe in the web app. */
export interface ScreenChannel {
    post(message: Record<string, unknown>): void;
}

/** What each host does its own way. */
export interface ScreenHostPorts {
    /** Open a link the screen asked for. The host applies its own allow-list. */
    openExternal(url: string): void;
    /** Answer a clipboard request (`dbmnModalReadClipboard` / `dbmnClipboardWrite`). */
    clipboard?(message: Record<string, unknown>, reply: (message: Record<string, unknown>) => void): Promise<void>;
}

type SubmitHandler = (fields: Record<string, string>) => Promise<void>;

export class ScreenSession implements ModalHost {
    private readonly pendingModalRequests = new Map<string, {
        resolve: (result: DbmnModalResult) => void;
        reject: (err: Error) => void;
        submitMap?: Record<string, SubmitHandler>;
    }>();

    constructor(private readonly channel: ScreenChannel, private readonly ports: ScreenHostPorts) {}

    post(message: Record<string, unknown>): void {
        this.channel.post(message);
    }

    /**
     * Open a DbmnModal in this screen and await the chosen action. `onSubmit` handlers stay on
     * the host (functions can't cross postMessage): the wire carries `awaitsHostSubmit` and the
     * screen asks the host to run the handler via `dbmnModalActionPending`.
     */
    showModal(spec: DbmnModalSpec): Promise<DbmnModalResult> {
        const submitMap: Record<string, SubmitHandler> = {};
        const wireActions = spec.actions.map(a => {
            if (typeof a.onSubmit === 'function') {
                submitMap[a.id] = a.onSubmit;
                const { onSubmit: _drop, ...rest } = a;
                void _drop;
                return { ...rest, awaitsHostSubmit: true };
            }
            return a;
        });
        const wireSpec = { ...spec, actions: wireActions };

        return new Promise<DbmnModalResult>((resolve, reject) => {
            const requestId = `modal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.pendingModalRequests.set(requestId, {
                resolve,
                reject,
                submitMap: Object.keys(submitMap).length > 0 ? submitMap : undefined
            });
            this.post({ type: 'dbmnModalRequest', requestId, spec: wireSpec });
            // Safety: if the screen is closed mid-prompt, the result never arrives. Cap at 5 minutes.
            setTimeout(() => {
                if (this.pendingModalRequests.has(requestId)) {
                    this.pendingModalRequests.delete(requestId);
                    resolve({ actionId: 'dismiss', fields: {} });
                }
            }, 5 * 60 * 1000);
        });
    }

    /** Open a link through the host (its allow-list applies). */
    openExternal(url: string): void {
        this.ports.openExternal(url);
    }

    /** The screen is going away: every open modal resolves as dismissed. */
    dismissAll(): void {
        this.pendingModalRequests.forEach(entry => entry.resolve({ actionId: 'dismiss', fields: {} }));
        this.pendingModalRequests.clear();
    }

    /** Messages every screen shares. Returns true when the message was this session's. */
    async handleShared(message: Record<string, unknown>): Promise<boolean> {
        switch (message.type) {
            case 'dbmnModalResult': {
                const requestId = message.requestId as string | undefined;
                const entry = requestId ? this.pendingModalRequests.get(requestId) : undefined;
                if (requestId && entry) {
                    this.pendingModalRequests.delete(requestId);
                    const result = message.result as (DbmnModalResult & { error?: string }) | undefined;
                    // dbmn-modal.js reports an `onSubmit` rejection as a result carrying `error`:
                    // turn it back into a rejection so the caller's try/catch fires.
                    if (result?.error) {
                        entry.reject(new Error(result.error));
                    } else {
                        entry.resolve(result || { actionId: 'dismiss', fields: {} });
                    }
                }
                return true;
            }
            case 'dbmnModalActionPending': {
                // The screen asks us to run an async submit handler; the modal keeps its spinner
                // until our reply arrives.
                const requestId = message.requestId as string | undefined;
                const submitId = message.submitId as string | undefined;
                const actionId = message.actionId as string | undefined;
                const fields = (message.fields as Record<string, string> | undefined) || {};
                if (!requestId || !submitId || !actionId) return true;
                const handler = this.pendingModalRequests.get(requestId)?.submitMap?.[actionId];
                if (!handler) {
                    this.post({ type: 'dbmnModalActionResult', submitId, success: false, error: 'No submit handler registered for this action.' });
                    return true;
                }
                handler(fields).then(
                    () => this.post({ type: 'dbmnModalActionResult', submitId, success: true }),
                    (err: unknown) => {
                        // Per-field validation errors ride on the thrown error as `.fieldErrors`;
                        // the screen paints them inline and keeps the modal open.
                        const fieldErrors = (err as { fieldErrors?: Record<string, string> })?.fieldErrors;
                        // "Not yet": the screen counts the wait down on the field (modalWaitError).
                        const wait = (err as { wait?: ModalWait })?.wait;
                        this.post({
                            type: 'dbmnModalActionResult',
                            submitId,
                            success: false,
                            error: err instanceof Error ? err.message : String(err),
                            ...(fieldErrors ? { fieldErrors } : {}),
                            ...(wait ? { wait } : {})
                        });
                    }
                );
                return true;
            }
            case 'dbmnModalReadClipboard':
            case 'dbmnClipboardWrite':
                await this.ports.clipboard?.(message, reply => this.post(reply));
                return true;
            case 'openExternalUrl': {
                // documentation-helpers.js sends the url in `payload` (survives the Console's
                // message normalizer); accept a top-level url from older callers.
                const url = (message.payload as { url?: string } | undefined)?.url ?? message.url;
                if (typeof url === 'string' && url) {
                    this.ports.openExternal(url);
                }
                return true;
            }
            default:
                return false;
        }
    }
}
