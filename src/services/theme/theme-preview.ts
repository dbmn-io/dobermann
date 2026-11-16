// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What a theme looks like, small: the colours the theme picker draws its mock DBMN screen in
 * (header, rail, catalogue rows with their method pills, a Run button), and the colours dbmn.io
 * wears in that theme. Both come from the same `--vscode-*` tokens the app itself wears, so a
 * card in the picker is the app in that theme, and the website follows the app.
 *
 * Portable: tokens in, colours out. The web and desktop apps send previews with the theme menu;
 * `npm run docs:themes` writes the same previews and site colours into the dbmn.io repo.
 */
import { contrast, mix } from './colour';
import type { ResolvedTheme, ThemeTokens } from './omarchy-vscode-theme';

/** The colours of one theme's mock screen. */
export interface ThemePreview {
    mode: 'light' | 'dark';
    /** The page, and the header over it. */
    background: string;
    /** The rail down the side. */
    sidebar: string;
    text: string;
    muted: string;
    border: string;
    /** The theme's own colour: focus, the current item. */
    accent: string;
    button: string;
    buttonText: string;
    /** The method pills, as the catalogue colours them (green is also success, red failure). */
    methods: { get: string; post: string; put: string; patch: string; delete: string };
}

/**
 * The standard Dark (VS Code's Dark Modern) for the colours a preview reads, as the page's own
 * sheet pins them (src/test/ui/harness/vscode-theme.css). A theme that leaves one of these out
 * is drawn over this, as the page is.
 */
const DARK_MODERN: Readonly<ThemeTokens> = {
    '--vscode-editor-background': '#1f1f1f',
    '--vscode-sideBar-background': '#181818',
    '--vscode-foreground': '#cccccc',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-panel-border': '#2b2b2b',
    '--vscode-focusBorder': '#0078d4',
    '--vscode-button-background': '#0078d4',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-charts-green': '#89d185',
    '--vscode-charts-blue': '#3794ff',
    '--vscode-charts-orange': '#d18616',
    '--vscode-charts-red': '#f14c4c',
    '--vscode-charts-purple': '#b180d7'
};

/** #rrggbb from a token, which may carry alpha (#rrggbbaa) or be short (#rgb). */
function solid(colour: string, fallback: string): string {
    const value = colour.trim();
    if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) return value.slice(0, 7).toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(value)) return ('#' + [...value.slice(1)].map(c => c + c).join('')).toLowerCase();
    return fallback;
}

/** The preview of a resolved theme; `undefined` is the page's own sheet, the standard Dark. */
export function previewOf(theme: ResolvedTheme | undefined): ThemePreview {
    const tokens: ThemeTokens = { ...DARK_MODERN, ...(theme?.tokens ?? {}) };
    const colour = (name: string) => solid(tokens[`--vscode-${name}`] ?? '', solid(DARK_MODERN[`--vscode-${name}`] ?? '', '#808080'));
    return {
        mode: theme?.kind === 'vscode-light' ? 'light' : 'dark',
        background: colour('editor-background'),
        sidebar: colour('sideBar-background'),
        text: colour('foreground'),
        muted: colour('descriptionForeground'),
        border: colour('panel-border'),
        accent: colour('focusBorder'),
        button: colour('button-background'),
        buttonText: colour('button-foreground'),
        methods: { get: colour('charts-green'), post: colour('charts-blue'), put: colour('charts-orange'), patch: colour('charts-purple'), delete: colour('charts-red') }
    };
}

/** `colour`, moved towards `toward` just far enough to read on `on` (WCAG `ratio`). */
function readable(colour: string, on: string, toward: string, ratio: number): string {
    for (let amount = 0; amount <= 1; amount += 0.05) {
        const candidate = mix(colour, toward, amount);
        if (contrast(candidate, on) >= ratio) return candidate;
    }
    return toward;
}

/**
 * dbmn.io's colours in a theme: the `--brand-*` properties of the site's css/brand.css. Surfaces
 * and borders are mixed from the page's own colours, so they read on light themes as well as dark.
 */
export function siteTokens(preview: ThemePreview): Record<string, string> {
    const { background, sidebar, text, muted, button, buttonText, methods } = preview;
    return {
        '--brand-bg-start': background,
        '--brand-bg-end': sidebar,
        '--brand-accent': button,
        '--brand-accent-text': buttonText,
        '--brand-text': text,
        '--brand-text-body': mix(background, text, 0.9),
        // A theme's muted colour is for the app's small print; the site sets paragraphs in it
        '--brand-text-muted': readable(muted, mix(background, text, 0.05), text, 4.5),
        '--brand-surface': mix(background, text, 0.05),
        '--brand-surface-strong': mix(background, text, 0.1),
        '--brand-border': mix(background, text, 0.15),
        '--brand-link': text,
        '--brand-link-underline': mix(background, text, 0.4),
        '--brand-success': methods.get,
        '--brand-info': methods.post,
        '--brand-warning': methods.put,
        '--brand-danger': methods.delete
    };
}
