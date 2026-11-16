// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #324: a portable copy of the `vscode.EventEmitter` / `vscode.Event` shape, so core can
 * publish events without VS Code. Listeners and their disposal behave as VS Code's do.
 */
export interface Disposable {
    dispose(): void;
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class EventEmitter<T> {
    private listeners: Array<{ fn: (e: T) => unknown; thisArgs?: unknown }> = [];

    readonly event: Event<T> = (fn, thisArgs, disposables) => {
        const entry = { fn, thisArgs };
        this.listeners.push(entry);
        const subscription: Disposable = {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== entry);
            }
        };
        disposables?.push(subscription);
        return subscription;
    };

    fire(event: T): void {
        for (const { fn, thisArgs } of [...this.listeners]) {
            fn.call(thisArgs, event);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}
