// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #324: the VS Code shell's sql.js execution storage. It builds `SqlJsStorageOptions` from
 * the extension context and the Dobermann workspace folder, and shows the corruption-recovery
 * notice natively.
 */
import { DATA_DIR } from '../../services/workspace/workspace-layout';
import * as vscode from 'vscode';
import * as path from 'path';
import { SqlJsExecutionStorage } from '../../services/storage/sqljs-execution-storage.service';
import { ensureDobermannWorkspaceFolder } from '../../utils/workspace-helper';
import { LoggerRegistry } from '../../utils/logger-registry';

export function createVsCodeExecutionStorage(context: vscode.ExtensionContext): SqlJsExecutionStorage {
    return new SqlJsExecutionStorage({
        resolveDatabaseDir: async () => {
            // Ensure DBMN's folder in the workspace (.dbmn, #344) exists
            const workspaceUri = await ensureDobermannWorkspaceFolder();
            const dobermannDir = vscode.Uri.joinPath(workspaceUri, DATA_DIR);
            await vscode.workspace.fs.createDirectory(dobermannDir);
            return dobermannDir.fsPath;
        },
        wasmPath: path.join(context.extensionPath, 'dist', 'sql-wasm.wasm'),
        schemaPath: path.join(context.extensionPath, 'dist', 'services', 'storage', 'sqlite-schema.sql'),
        logger: LoggerRegistry.getDiagnosticLogger(),
        notifyCorruptionRecovered: showCorruptionRecoveredNotice
    });
}

/**
 * Show the persistent native notification after corruption recovery.
 * Uses vscode.window directly (not the IToastService) — DB init runs
 * during early activation when the toast service may not yet be wired
 * onto globals. Action buttons keep the notification in the panel
 * until the user acknowledges it; without buttons VS Code would
 * auto-dismiss after ~5 seconds.
 */
function showCorruptionRecoveredNotice(corruptPath: string, loadErr: unknown): void {
    const errMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
    const message =
        `DBMN: Transaction history database was corrupted on load and has been reset.\n\n` +
        `Your other DBMN data (environments, endpoints, settings, sign-in) is untouched — only the ` +
        `local transaction-history store was affected.\n\n` +
        `Your previous database has been preserved at:\n${corruptPath}\n\n` +
        `If you need help recovering the history, contact support@dbmn.io and attach the corrupted file ` +
        `(or send the path above). Cause reported by SQLite: "${errMsg}".`;

    const supportSubject = encodeURIComponent('DBMN — Corrupted transaction database (recovery request)');
    const supportBody = encodeURIComponent(
        `Hi DBMN support,\n\n` +
        `My transaction database was corrupted and reset on extension activation.\n\n` +
        `Corrupted file (preserved): ${corruptPath}\n` +
        `SQLite error: ${errMsg}\n\n` +
        `Please advise on recovery options.\n\nThanks.`
    );
    const mailto = `mailto:support@dbmn.io?subject=${supportSubject}&body=${supportBody}`;

    // Fire-and-forget — never block activation on this notification.
    Promise.resolve().then(() =>
        vscode.window.showWarningMessage(
            message,
            { modal: false },
            'Show Backup File',
            'Copy File Path',
            'Email Support'
        )
    ).then(choice => {
        if (choice === 'Show Backup File') {
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(corruptPath));
        } else if (choice === 'Copy File Path') {
            vscode.env.clipboard.writeText(corruptPath);
            vscode.window.showInformationMessage(`Copied: ${corruptPath}`);
        } else if (choice === 'Email Support') {
            vscode.env.openExternal(vscode.Uri.parse(mailto));
        }
    }).then(undefined, () => { /* user dismissed — fine */ });
}
