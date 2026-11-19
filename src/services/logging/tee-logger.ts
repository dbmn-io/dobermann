// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import type { IExtensionDiagnosticLogger } from './extension-diagnostic-logger.interface';

/**
 * One logger that writes to several. Dobermann issue 7: while the Logs screen is being built,
 * VS Code's diagnostic logging goes to the app's log and to its old Output channel both; the
 * channel goes once Logs can show everything.
 */
export function teeLogger(...loggers: IExtensionDiagnosticLogger[]): IExtensionDiagnosticLogger {
    const each = (call: (l: IExtensionDiagnosticLogger) => void) => {
        for (const l of loggers) {
            try { call(l); } catch { /* one logger failing never stops the others */ }
        }
    };
    return {
        info: (m, ...a) => each(l => l.info(m, ...a)),
        warn: (m, ...a) => each(l => l.warn(m, ...a)),
        error: (m, e, ...a) => each(l => l.error(m, e, ...a)),
        debug: (m, ...a) => each(l => l.debug(m, ...a)),
        trace: (m, ...a) => each(l => l.trace(m, ...a)),
        show: () => each(l => l.show()),
        clear: () => each(l => l.clear()),
        dispose: () => each(l => l.dispose())
    };
}
