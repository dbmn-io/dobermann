// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { IToastService } from './toast.interface';

/**
 * Access the portable toast service from non-DI code.
 *
 * `extension.ts` publishes the `VSCodeToastService` singleton onto
 * `global.dbmnToastService` during activation (see Architecture.md →
 * "Accessing IToastService from non-DI code"). Feature code that isn't
 * constructor-injected yet uses this accessor instead of naming
 * `vscode.window.*` directly, so notifications route to the visible DBMN
 * webview (or a coalesced native nudge) and a future web build can swap the
 * toast layer without touching call sites.
 *
 * Returns `undefined` before activation wires the singleton — callers use
 * optional chaining (`getToast()?.info(...)`). For confirms / actionable
 * dialogs use `DbmnModal`, not this.
 */
export function getToast(): IToastService | undefined {
    return (global as Record<string, unknown>).dbmnToastService as IToastService | undefined;
}
