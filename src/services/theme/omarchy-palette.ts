// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * An Omarchy theme's colours (#373: the desktop app follows the desktop's theme). Every Omarchy
 * theme is a `colors.toml` of named colours; the desktop app reads the current one from
 * `~/.local/state/omarchy/current/theme/colors.toml`, and ships Omarchy's stock themes
 * (omarchy-themes.generated.ts) for a computer without Omarchy.
 *
 * `resolvePalette` is Omarchy's own cascade (omarchy-theme-color in omarchy 4.0.4): legacy
 * `bg`/`fg` and ANSI `color0`..`color15` names, `purple` for `magenta`, missing shades derived
 * by mixing, `mode` from the background's brightness when a theme doesn't say. Every Omarchy
 * consumer resolves a theme this way, so a palette here is what Omarchy's templates see.
 *
 * Portable: no Node, no Electron, no VS Code. The file's text comes in, a palette comes out.
 */
import { z } from 'zod';
import { mix } from './colour';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour');

/** The resolved palette: every colour Omarchy's VS Code template reads, plus the shades. */
export const omarchyPaletteSchema = z.object({
    mode: z.enum(['dark', 'light']),
    accent: hex,
    selection: hex,
    selection_background: hex,
    selection_foreground: hex,
    muted: hex,
    background: hex,
    dark_background: hex,
    darker_background: hex,
    lighter_background: hex,
    foreground: hex,
    dark_foreground: hex,
    light_foreground: hex,
    bright_foreground: hex,
    red: hex,
    yellow: hex,
    green: hex,
    cyan: hex,
    blue: hex,
    magenta: hex,
    orange: hex,
    brown: hex,
    bright_red: hex,
    bright_yellow: hex,
    bright_green: hex,
    bright_cyan: hex,
    bright_blue: hex,
    bright_magenta: hex
}).passthrough();
export type OmarchyPalette = z.infer<typeof omarchyPaletteSchema>;

/**
 * The `key = value` pairs of a colors.toml, as Omarchy reads them: quotes optional, inline
 * comments after a quoted value ignored, keys and values limited to the characters a palette
 * needs (anything else is skipped, as Omarchy skips it).
 */
export function parseColorsValues(text: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const at = raw.indexOf('=');
        if (at < 0) continue;
        const key = raw.slice(0, at).replace(/["' ]/g, '');
        if (!key || key.startsWith('#')) continue;
        let value = raw.slice(at + 1);
        const quote = /["']/.exec(value);
        if (quote) {
            value = value.slice(quote.index + 1);
            value = value.slice(0, /["']/.exec(value)?.index ?? value.length);
        } else {
            value = value.trim();
        }
        if (!/^[A-Za-z0-9_-]+$/.test(key) || !/^[A-Za-z0-9#(),._+/% -]*$/.test(value)) continue;
        values[key] = value;
    }
    return values;
}

const LEGACY_PALETTE: Record<string, string> = {
    background: 'bg', dark_background: 'dark_bg', darker_background: 'darker_bg', lighter_background: 'lighter_bg',
    foreground: 'fg', dark_foreground: 'dark_fg', light_foreground: 'light_fg', bright_foreground: 'bright_fg'
};
const ANSI: Record<string, string> = {
    color0: 'background', color1: 'red', color2: 'green', color3: 'yellow', color4: 'blue', color5: 'magenta', color6: 'cyan',
    color7: 'foreground', color8: 'muted', color9: 'bright_red', color10: 'bright_green', color11: 'bright_yellow',
    color12: 'bright_blue', color13: 'bright_magenta', color14: 'bright_cyan', color15: 'bright_foreground'
};
const isHex = (value: string | undefined): value is string => !!value && /^#[0-9a-fA-F]{6}$/.test(value);

/** Omarchy's cascade over the raw pairs: aliases, fallbacks, derived shades, mode. */
export function resolvePalette(raw: Record<string, string>): Record<string, string> {
    const c: Record<string, string> = { ...raw };
    const alias = (key: string, from: string) => { if (!c[key] && c[from]) c[key] = c[from]; };
    const mixed = (a: string | undefined, b: string, amount: number) => (isHex(a) ? mix(a, b, amount) : a ?? '');
    for (const [key, legacy] of Object.entries(LEGACY_PALETTE)) alias(key, legacy);
    alias('background', 'color0');
    alias('foreground', 'color7');
    if (c.background) c.color0 = c.background;
    if (c.foreground) c.color7 = c.foreground;
    for (const [ansi, key] of Object.entries(ANSI)) if (!['color0', 'color7', 'color8', 'color15'].includes(ansi)) alias(key, ansi);
    alias('magenta', 'purple');
    alias('bright_magenta', 'bright_purple');
    if (!c.light_foreground) c.light_foreground = c.color7 || c.foreground;
    if (!c.bright_foreground) c.bright_foreground = c.color15 || c.foreground;
    c.cursor = c.bright_foreground;
    if (!c.lighter_background) c.lighter_background = c.color0 || c.background;
    if (!c.dark_foreground) c.dark_foreground = c.color8 || c.foreground;
    if (!c.muted) c.muted = c.color8 || c.dark_foreground;
    if (!c.selection) c.selection = c.selection_background || c.color8 || c.color0 || c.background;
    if (!c.selection_background) c.selection_background = c.selection;
    if (!c.selection_foreground) c.selection_foreground = c.bright_foreground;
    if (!c.orange) c.orange = c.yellow;
    if (!c.brown) c.brown = mixed(c.orange, '#000000', 0.5);
    if (!c.dark_background) c.dark_background = mixed(c.background, '#000000', 0.25);
    if (!c.darker_background) c.darker_background = mixed(c.background, '#000000', 0.5);
    for (const base of ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']) if (!c[`bright_${base}`]) c[`bright_${base}`] = mixed(c[base], '#ffffff', 0.2);
    alias('purple', 'magenta');
    alias('bright_purple', 'bright_magenta');
    for (const [ansi, key] of Object.entries(ANSI)) alias(ansi, key);
    for (const [key, legacy] of Object.entries(LEGACY_PALETTE)) if (c[key]) c[legacy] = c[key];
    if (!c.mode) c.mode = c.theme_type;
    if (!c.mode) {
        if (isHex(c.background)) {
            const sum = [1, 3, 5].reduce((total, at) => total + parseInt(c.background.slice(at, at + 2), 16), 0);
            c.mode = sum > 382 ? 'light' : 'dark';
        } else {
            c.mode = 'dark';
        }
    }
    c.theme_type = c.mode;
    // Not Omarchy's: a theme without an accent would leave Omarchy's template broken; here it gets its blue
    if (!c.accent && c.blue) c.accent = c.blue;
    return c;
}

/**
 * The palette in a theme's `colors.toml`, resolved, or why it isn't one: a missing or malformed
 * colour names itself.
 */
export function parseColorsToml(text: string): { ok: true; palette: OmarchyPalette } | { ok: false; error: string } {
    const parsed = omarchyPaletteSchema.safeParse(resolvePalette(parseColorsValues(text)));
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, error: `${issue.path.join('.') || 'colors.toml'}: ${issue.message}` };
    }
    return { ok: true, palette: parsed.data };
}

/** "tokyo-night" as Omarchy shows it: "Tokyo Night". */
export function omarchyThemeName(slug: string): string {
    return slug.split(/[-_]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}
