// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * 0.4.1: the web and desktop apps' usage rows (web/src/shell/telemetry.ts) name the platform as
 * VS Code's do. Portable: no `vscode` import, and the browser's navigator is passed in.
 */

/** The platform in the words VS Code's rows use (`linux`, `win32`, `darwin`). */
export function browserPlatform(nav: { userAgent?: string; platform?: string } = navigator): string {
    const text = `${nav.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase();
    if (text.includes('win')) return 'win32';
    if (text.includes('mac') || text.includes('iphone') || text.includes('ipad')) return 'darwin';
    if (text.includes('linux') || text.includes('x11') || text.includes('cros')) return 'linux';
    return 'unknown';
}
