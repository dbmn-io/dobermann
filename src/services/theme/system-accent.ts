// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The computer's accent colour on the standard Light and Dark themes (#373). Windows and macOS
 * let the user pick an accent; the desktop app reads it (desktop/src/main.ts) and the standard
 * themes wear it where VS Code's own blue was: the main button, the focus ring, the progress
 * bar, links where they still read, and (dark) the selected row. A named theme keeps its own.
 *
 * Portable: a colour in, tokens out.
 */
import { contrast, mix } from './colour';
import type { ThemeTokens } from './omarchy-vscode-theme';

/** An accent as a host reports it (`rrggbb`, `rrggbbaa`, with or without #), as #rrggbb; else undefined. */
export function normaliseAccent(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const match = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(raw.trim());
    return match ? `#${match[1].toLowerCase()}` : undefined;
}

/** What a button's text needs against its background, and a link against the page (WCAG AA). */
const BUTTON_TEXT_CONTRAST = 3;
const LINK_CONTRAST = 4.5;

/** The tokens `accent` changes on a standard theme whose page background is `background`. */
export function accentTokens(accent: string, kind: 'light' | 'dark', background: string): ThemeTokens {
    const tokens: ThemeTokens = {
        '--vscode-button-background': accent,
        '--vscode-button-hoverBackground': mix(accent, '#000000', 0.12),
        '--vscode-button-foreground': contrast('#ffffff', accent) >= BUTTON_TEXT_CONTRAST ? '#ffffff' : '#1f1f1f',
        '--vscode-focusBorder': accent,
        '--vscode-progressBar-background': accent
    };
    // A link must read as text: an accent too close to the page keeps the theme's own link colour
    if (contrast(accent, background) >= LINK_CONTRAST) {
        tokens['--vscode-textLink-foreground'] = accent;
        tokens['--vscode-textLink-activeForeground'] = accent;
    }
    // Dark Modern's selected row is its blue, deepened; Light Modern's is grey and stays
    if (kind === 'dark') tokens['--vscode-list-activeSelectionBackground'] = mix(background, accent, 0.35);
    return tokens;
}
