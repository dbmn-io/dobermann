// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Omarchy's VS Code theme, for DBMN's screens (#373). Omarchy renders a complete VS Code colour
 * theme for every theme it sets (`default/themed/vscode-theme.json.tpl`, 668 colours over the
 * palette), and VS Code on Omarchy wears it. Outside VS Code DBMN wears the same: the template
 * is bundled (omarchy-vscode-template.generated.ts) and rendered over a palette here, or the
 * desktop's own rendering (`current/theme/vscode-theme.json`) is taken as it is. One mapping,
 * Omarchy's, on every host: nothing of DBMN's own to keep in step.
 *
 * The result is `--vscode-*` properties, which is what VS Code injects: the same tokens the
 * screens read there, by the same names (`editor.background` → `--vscode-editor-background`).
 */
import { z } from 'zod';
import type { OmarchyPalette } from './omarchy-palette';
import { mix } from './colour';
import { OMARCHY_VSCODE_TEMPLATE } from './omarchy-vscode-template.generated';

/** A VS Code colour theme's colours, as its JSON holds them (`workbench.colorCustomizations` names). */
export const vscodeColorThemeSchema = z.object({
    type: z.enum(['dark', 'light']),
    colors: z.record(z.string(), z.string())
});
export type VscodeColorTheme = z.infer<typeof vscodeColorThemeSchema>;

export type ThemeTokens = Record<string, string>;

export interface ResolvedTheme {
    tokens: ThemeTokens;
    /** VS Code's body class and `data-vscode-theme-kind`: what light-aware CSS and Monaco read. */
    kind: 'vscode-dark' | 'vscode-light';
}

const HEX6 = /^#[0-9A-Fa-f]{6}$/;

/**
 * Omarchy 4.5's `{{ mix start end amount }}` (omarchy-theme-set-templates): `amount` of `end` over
 * `start`, two palette colours; `40%`, or a number (above 1 read as a percentage), held to 0–1.
 * `mix_strip` drops the `#`, `mix_rgb` gives `r,g,b`. Undefined when either isn't a hex colour, which
 * Omarchy leaves unfilled too.
 */
export function omarchyMix(values: Record<string, string>, fn: string, startKey: string, endKey: string, amountText: string): string | undefined {
    const start = values[startKey];
    const end = values[endKey];
    if (!start || !end || !HEX6.test(start) || !HEX6.test(end)) return undefined;
    let amount = amountText.endsWith('%') ? Number(amountText.slice(0, -1)) / 100 : Number(amountText);
    if (!amountText.endsWith('%') && amount > 1) amount /= 100;
    amount = Math.max(0, Math.min(1, amount));
    const colour = mix(start, end, amount);
    if (fn === 'mix_strip') return colour.slice(1);
    if (fn === 'mix_rgb') return [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16)).join(',');
    return colour;
}

/** Omarchy's template over `palette`: what `omarchy theme set` writes as vscode-theme.json. */
export function renderVscodeTheme(palette: OmarchyPalette): VscodeColorTheme {
    const values = palette as Record<string, string>;
    const fill = (text: string) => text
        .replace(/\{\{\s*(mix|mix_strip|mix_rgb)\s+([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s+([0-9]+(?:\.[0-9]+)?%?)\s*\}\}/g,
            (whole, fn: string, start: string, end: string, amount: string) => omarchyMix(values, fn, start, end, amount) ?? whole)
        .replace(/\{\{ ([A-Za-z0-9_]+) \}\}/g, (whole, key: string) => values[key] ?? whole);
    const colors: Record<string, string> = {};
    for (const [name, value] of Object.entries(OMARCHY_VSCODE_TEMPLATE.colors)) {
        const filled = fill(value);
        if (!filled.includes('{{')) colors[name] = filled;   // a colour the palette doesn't name is left to the page's sheet
    }
    return { type: fill(OMARCHY_VSCODE_TEMPLATE.type) === 'light' ? 'light' : 'dark', colors };
}

/**
 * Tokens DBMN's sheets read that no VS Code theme names (VS Code derives or leaves them), filled
 * from the theme's nearest colour so a light theme doesn't keep Dark Modern's.
 */
const DERIVED: Record<string, string> = {
    'list.headerBackground': 'sideBarSectionHeader.background',
    'list.headerForeground': 'sideBarSectionHeader.foreground',
    'errorList.errorForeground': 'list.errorForeground',
    errorBackground: 'inputValidation.errorBackground',
    errorBorder: 'inputValidation.errorBorder',
    'widget.border': 'editorWidget.border'
};

/** The theme as `--vscode-*` properties, the way VS Code puts a theme on a webview. */
export function tokensFromVscodeTheme(theme: VscodeColorTheme): ResolvedTheme {
    const tokens: ThemeTokens = {};
    const token = (name: string) => `--vscode-${name.replace(/\./g, '-')}`;
    for (const [name, value] of Object.entries(theme.colors)) tokens[token(name)] = value;
    for (const [name, from] of Object.entries(DERIVED)) if (theme.colors[from] && !theme.colors[name]) tokens[token(name)] = theme.colors[from];
    if (!theme.colors.contrastBorder) tokens[token('contrastBorder')] = 'transparent';
    return { tokens, kind: theme.type === 'light' ? 'vscode-light' : 'vscode-dark' };
}
