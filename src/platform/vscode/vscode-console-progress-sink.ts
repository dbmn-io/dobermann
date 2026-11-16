// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #320: the VS Code shell's progress sink: the core ConsoleProgressSink, opening Consoles
 * through `dbmn.viewTransactionReport` (a Hub tab).
 */
import * as vscode from 'vscode';
import { ConsoleProgressSink } from '../../screens/console/console-progress-sink';

export class VsCodeConsoleProgressSink extends ConsoleProgressSink {
    constructor() {
        super(async (executionId, options) => {
            await vscode.commands.executeCommand('dbmn.viewTransactionReport', {
                id: executionId,
                executionId,
                isBatch: options.isBatch,
                ...(options.focus !== undefined ? { focus: options.focus } : {})
            });
        });
    }
}
