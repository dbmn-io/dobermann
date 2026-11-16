// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * File sink — an abstraction over "persist these bytes to a location the user
 * chooses" (Issue #275 / portability path — see docs/portability/spa-migration.md).
 *
 * Export logic (building a ZIP, a CSV, a template) shouldn't care HOW the file
 * lands on disk. Today the VS Code implementation shows `showSaveDialog` and
 * writes via `workspace.fs`; on the eject path this same seam swaps for a
 * browser download without touching any export logic. Keeping the dependency
 * pointed at this interface means the only `vscode.window.showSaveDialog` call
 * for app-produced files lives behind one swappable class.
 */
export interface FileSaveRequest {
    /** Suggested file name including extension, e.g. "dbmn-endpoints.dbmn.zip". */
    suggestedName: string;
    /** The bytes to write. */
    data: Uint8Array;
    /**
     * Optional save-dialog filters: label → list of extensions (no leading dot),
     * e.g. `{ 'Dobermann Export': ['dbmn.zip', 'zip'] }`. Implementations that
     * can't express filters (e.g. a browser download) ignore this.
     */
    filters?: Record<string, string[]>;
}

export interface FileSaveResult {
    /** True when the file was written. */
    saved: boolean;
    /** Absolute path it was written to (for user feedback). Undefined if cancelled. */
    path?: string;
    /** True when the user cancelled the save. */
    cancelled?: boolean;
}

export interface IFileSink {
    save(request: FileSaveRequest): Promise<FileSaveResult>;
}
