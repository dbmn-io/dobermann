// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IToastService, ToastDelivery, ToastOptions, ToastPayload, TOAST_TARGETS_KEY } from './toast.interface';

/**
 * VS Code implementation of IToastService.
 *
 * Delivery model (designed with the user — no per-notification native spam):
 *   1. `forceNative` → straight to `vscode.window.show*Message`. For rare,
 *      critical/blocking alerts (auth/licensing) the user must see even if they
 *      never open DBMN.
 *   2. A DBMN webview is open AND visible → render live in its `DbmnToast`
 *      overlay (the common, real-time case).
 *   3. No visible webview → **queue** the toast in the host and show ONE
 *      coalesced, actionable nudge ("New notifications from DBMN — View"). When
 *      the user clicks View, the Hub opens/reveals and the queued toasts replay
 *      via `drainPending()` — so nothing is missed and the native channel isn't
 *      spammed.
 *
 * This is the only place that calls `vscode.window.show*Message` for transient
 * notifications — feature code injects IToastService so a future web build can
 * swap to a pure DOM toast layer (GitHub Issue #263).
 */
export class VSCodeToastService implements IToastService {
    /** Toasts that fired while no DBMN webview was visible, awaiting replay. */
    private pending: ToastPayload[] = [];
    private static readonly MAX_PENDING = 50;
    /** True while a "you have notifications" nudge is outstanding, so we coalesce. */
    private nudgeShown = false;
    /** Command that opens/reveals the Hub (see package.json contributes.commands). */
    private static readonly OPEN_HUB_COMMAND = 'dbmn.openHub';
    /** Recently-emitted `level|message` → timestamp, to drop duplicate toasts
     *  fired in quick succession. Two emitters reacting to the same event (e.g.
     *  a token-expiry check firing from both an immediate check and an interval)
     *  shouldn't stack visible copies. */
    private recent = new Map<string, number>();
    private static readonly DEDUP_WINDOW_MS = 2000;

    info(message: string, opts?: ToastOptions): void { this.handle('info', message, opts); }
    warn(message: string, opts?: ToastOptions): void { this.handle('warn', message, opts); }
    error(message: string, opts?: ToastOptions): void { this.handle('error', message, opts); }

    private handle(level: ToastPayload['level'], message: string, opts?: ToastOptions): void {
        if (opts?.forceNative) { this.native(level, message); return; }
        // Dedup identical toasts within a short window (kills the ×2 duplication).
        const key = level + '|' + message;
        const now = Date.now();
        const last = this.recent.get(key);
        if (last !== undefined && now - last < VSCodeToastService.DEDUP_WINDOW_MS) return;
        this.recent.set(key, now);
        if (this.recent.size > 64) {
            for (const [k, t] of this.recent) {
                if (now - t >= VSCodeToastService.DEDUP_WINDOW_MS) this.recent.delete(k);
            }
        }
        const payload: ToastPayload = { level, message, opts };
        if (this.deliverToVisible(payload)) return;
        this.enqueue(payload);
        this.showNudge();
    }

    /**
     * Replay queued toasts into a now-visible webview. Called by the Hub when it
     * becomes ready/visible. Toasts that still can't be delivered stay queued.
     */
    drainPending(): void {
        if (this.pending.length === 0) { this.nudgeShown = false; return; }
        const remaining: ToastPayload[] = [];
        for (const payload of this.pending) {
            if (!this.deliverToVisible(payload)) remaining.push(payload);
        }
        this.pending = remaining;
        if (this.pending.length === 0) this.nudgeShown = false;
    }

    private deliverToVisible(payload: ToastPayload): boolean {
        const targets = (globalThis as Record<string, unknown>)[TOAST_TARGETS_KEY] as Set<ToastDelivery> | undefined;
        if (!targets || targets.size === 0) return false;
        for (const deliver of targets) {
            try {
                if (deliver(payload)) return true;
            } catch {
                // A broken target must not block other targets or queueing.
            }
        }
        return false;
    }

    private enqueue(payload: ToastPayload): void {
        this.pending.push(payload);
        // Bound the backlog — drop the oldest so a long-closed Hub can't grow it
        // without limit.
        if (this.pending.length > VSCodeToastService.MAX_PENDING) {
            this.pending.splice(0, this.pending.length - VSCodeToastService.MAX_PENDING);
        }
    }

    /** One coalesced native nudge while toasts are queued; clicking View opens
     *  the Hub, which drains the queue. */
    private showNudge(): void {
        if (this.nudgeShown) return;
        this.nudgeShown = true;
        void vscode.window.showInformationMessage('New notifications from DBMN', 'View').then(choice => {
            if (choice === 'View') {
                // Opening the Hub triggers its ready/visible handler → drainPending().
                void vscode.commands.executeCommand(VSCodeToastService.OPEN_HUB_COMMAND);
            } else {
                // Dismissed without viewing — allow a fresh nudge for later toasts.
                this.nudgeShown = false;
            }
        });
    }

    private native(level: ToastPayload['level'], message: string): void {
        if (level === 'error') { void vscode.window.showErrorMessage(message); return; }
        if (level === 'warn') { void vscode.window.showWarningMessage(message); return; }
        void vscode.window.showInformationMessage(message);
    }
}
