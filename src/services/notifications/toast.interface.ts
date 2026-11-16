// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Portable toast/notification interface (GitHub Issue #263).
 *
 * The point of this abstraction is to let feature code show a one-line
 * notification ("link sent", "saved", "couldn't reach server") without
 * naming a specific runtime. The VS Code build wires this to a visibility-aware
 * router: if a DBMN webview is open and visible the message renders in our own
 * `DbmnToast` overlay; otherwise it falls back to
 * `vscode.window.show{Info,Warn,Error}Message` so it is never lost. A future
 * web-only build swaps in a pure DOM toast with the same surface.
 *
 * Use this for **cross-surface** notifications from extension-host code —
 * anything the host wants to tell the user that isn't scoped to one webview.
 * Notifications that are purely real-time inside an open webview should call
 * `window.DbmnToast` directly (no host round-trip).
 *
 * Governing principle: a toast fires only when it tells the user something
 * important that isn't already conveyed by other UX (a modal, inline status,
 * or the UI updating itself). No double-notification; no toasts for routine,
 * can't-fail actions.
 *
 * No await — toasts are fire-and-forget. Long-running confirmations or
 * blocking choices belong in `DbmnModal`, not here.
 */
export interface ToastOptions {
    /** Stay until dismissed instead of auto-hiding. */
    persistent?: boolean;
    /** Auto-hide delay in ms (ignored when persistent). */
    durationMs?: number;
    /**
     * Always use the native VS Code notification, even if a DBMN webview is
     * visible. For critical alerts that must surface regardless of where the
     * user is looking.
     */
    forceNative?: boolean;
}

export interface IToastService {
    info(message: string, opts?: ToastOptions): void;
    warn(message: string, opts?: ToastOptions): void;
    error(message: string, opts?: ToastOptions): void;
}

/**
 * Delivery function a webview manager registers so the router can render a
 * host-origin toast inside a visible webview. Returns `true` only if the
 * webview was visible AND the message was posted to it; `false` otherwise so
 * the router can try the next target or fall back to native.
 */
export type ToastDelivery = (payload: ToastPayload) => boolean;

export interface ToastPayload {
    level: 'info' | 'warn' | 'error';
    message: string;
    opts?: ToastOptions;
}

/** Global registry of webview delivery targets, keyed off globalThis to avoid
 *  import cycles (mirrors the `dbmnShowModal` bridge). */
export const TOAST_TARGETS_KEY = '__dbmnToastTargets';
