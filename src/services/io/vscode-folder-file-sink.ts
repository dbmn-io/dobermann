// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IFileSink, FileSaveRequest, FileSaveResult } from './file-sink.interface';

/**
 * {@link IFileSink} into a folder the user already chose: no second dialog. Used for the copy
 * saved before the API Catalogue moves to the account (#342). An existing file of the same name
 * is never overwritten: the new one gets a number.
 */
export class VsCodeFolderFileSink implements IFileSink {
    constructor(private readonly folder: vscode.Uri) {}

    async save(request: FileSaveRequest): Promise<FileSaveResult> {
        const dot = request.suggestedName.indexOf('.');
        const [stem, extension] = dot > 0
            ? [request.suggestedName.slice(0, dot), request.suggestedName.slice(dot)]
            : [request.suggestedName, ''];
        for (let n = 1; ; n++) {
            const uri = vscode.Uri.joinPath(this.folder, n === 1 ? request.suggestedName : `${stem} (${n})${extension}`);
            try {
                await vscode.workspace.fs.stat(uri);
                continue;   // taken
            } catch {
                await vscode.workspace.fs.writeFile(uri, request.data);
                return { saved: true, path: uri.fsPath };
            }
        }
    }
}
