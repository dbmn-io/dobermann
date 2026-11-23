// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which of the web app's file writes go out at once (web/src/shell/node/fs.ts keeps files in memory and writes them
 * behind, to IndexedDB or the workspace folder). A change saved just before a reload was lost when every write waited
 * 300 ms (2026-11-23: a saved search deleted, the page reloaded at once, and it came back).
 *
 * At once: a small JSON file written whole, or removed: a saved query (Queries/<name>/query.json), a lookup table, a
 * setting. Saved on a click, so writing each at once costs nothing. Batched (the next flush, 300 ms on): the run
 * history's database (sql.js writes it whole, often), a run's archive growing by appends, temporary files (the rename
 * after them is the save), and anything over WRITE_NOW_MAX: they would otherwise start a write on every change.
 */
export const WRITE_NOW_MAX = 256 * 1024;

/** `size`: the file's bytes now (0: removed). `appended`: it only grew. */
export function writesNow(path: string, size: number, appended: boolean): boolean {
    return !appended && size <= WRITE_NOW_MAX && /\.json$/i.test(path);
}
