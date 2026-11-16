// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * VS Code's embedded tabs can't fetch webview-resource URLs, so webview-base bakes each screen's
 * `<script src>` into the HTML. A tag's other attributes stay: a page script reads what its
 * builder filled in from its own tag (#372: the Console's and Run Batch's `data-*`, through
 * `document.currentScript`, which an inline script has too).
 */

/** The file a `src` points at: its name and contents, or undefined to leave the tag alone. */
export type ScriptSource = (src: string) => { name: string; js: string } | undefined;

/** `<script src="…" data-…></script>` → `<script data-… data-embedded-from="…">…</script>`. */
export function inlineScriptTags(html: string, source: ScriptSource): string {
    return html.replace(/<script(\s+[^>]*?)\s*src\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi, (match, before: string, src: string, after: string) => {
        const file = source(src);
        if (!file) return match;
        const attributes = `${before}${after}`.trim();
        return `<script${attributes ? ` ${attributes}` : ''} data-embedded-from="${file.name}">${file.js}\n//# sourceURL=embedded:${file.name}\n</script>`;
    });
}
