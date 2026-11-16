// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IFileSink, FileSaveRequest, FileSaveResult } from './file-sink.interface';

/**
 * VS Code implementation of {@link IFileSink}: the standard OS save dialog
 * (folder + filename in one native dialog) followed by a `workspace.fs` write.
 *
 * This is deliberately the ONLY place that calls `vscode.window.showSaveDialog`
 * for app-produced files. On the portability path (eject from VS Code) the DI
 * composition swaps this for a browser-download sink; nothing in the export
 * logic changes because it depends on the interface, not this class.
 */
export class VsCodeFileSink implements IFileSink {
    async save(request: FileSaveRequest): Promise<FileSaveResult> {
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(request.suggestedName),
            filters: request.filters
        });
        if (!saveUri) {
            return { saved: false, cancelled: true };
        }
        await vscode.workspace.fs.writeFile(saveUri, request.data);
        return { saved: true, path: saveUri.fsPath };
    }
}
