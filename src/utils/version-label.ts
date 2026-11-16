// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #447: the version every app shows, with the commit it was built from: "v0.4.0 · 64ca0bc". The
 * web app ships from main far more often than DBMN for VS Code is released, so the number alone
 * can't tell two builds apart; the commit can, releases included.
 *
 * Each host finds its own commit at build time: VS Code's bundle has it baked in by webpack
 * (`__DBMN_COMMIT__`, read by `bundledCommit()`), the web app and the desktop app from
 * `git rev-parse` in their build scripts (web/scripts/shell-config.ts).
 */

/** Set by webpack's DefinePlugin (webpack.config.js); absent when run from tsc's output (the tests). */
declare const __DBMN_COMMIT__: string | undefined;

/** "v0.4.0 · 64ca0bc"; "v0.4.0" without a commit; nothing without a version. */
export function versionLabel(version: string | undefined, commit?: string): string {
    if (!version) return '';
    return commit ? `v${version} · ${commit}` : `v${version}`;
}

/** The commit VS Code's bundle was built from, or '' when it wasn't bundled. */
export function bundledCommit(): string {
    return typeof __DBMN_COMMIT__ === 'string' ? __DBMN_COMMIT__ : '';
}
