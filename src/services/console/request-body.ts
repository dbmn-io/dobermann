// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #306: a request body that is blank, `{}` or `[]` carries nothing —
 * the Raw tab shows the request's Details instead of an empty body.
 * Mirrors RawTabHandler.isEmptyBody in the console webview.
 */
export function isEmptyRequestBody(content: string | null | undefined): boolean {
    if (content === null || content === undefined) {
        return true;
    }
    const trimmed = content.trim();
    if (trimmed === '') {
        return true;
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length === 0;
    } catch {
        return false;
    }
}
