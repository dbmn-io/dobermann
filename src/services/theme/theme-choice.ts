// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which theme the app wears, outside VS Code (#373). The user picks one in Settings › UI:
 *
 *   system    follow the computer (the choice until one is made). On Omarchy that is the
 *             desktop's current theme, and every change to it. In VS Code it is VS Code's
 *             theme, as DBMN's panels get it. Anywhere else it is the computer's light or dark
 *             setting: the user's light theme or their dark one (the standard Light and Dark
 *             until they pick others)
 *   default   the standard Dark: the page's own sheet (VS Code's Dark Modern)
 *   light     the standard Light (VS Code's Light Modern, standard-light.ts)
 *   theme:x   one of Omarchy's stock themes, bundled (omarchy-themes.generated.ts)
 *
 * A bundled theme is Omarchy's VS Code theme for that palette (omarchy-vscode-theme.ts), and so
 * is the desktop's: its own rendering when it reports one, the bundled template over the palette
 * otherwise. The standard themes wear the computer's accent colour where the host reports one
 * (system-accent.ts); a named theme keeps its own.
 *
 * The choice is the device's (a browser's or an installation's), not the account's: a theme
 * follows the screen it is on. Portable: the host stores the strings and reports what it knows
 * of the computer (ThemeHost).
 */
import { omarchyThemeName, type OmarchyPalette } from './omarchy-palette';
import { OMARCHY_THEMES } from './omarchy-themes.generated';
import { renderVscodeTheme, tokensFromVscodeTheme, type ResolvedTheme, type ThemeTokens, type VscodeColorTheme } from './omarchy-vscode-theme';
import { STANDARD_DARK_TOKENS } from './standard-dark';
import { STANDARD_LIGHT_TOKENS } from './standard-light';
import { accentTokens } from './system-accent';
import { previewOf, type ThemePreview } from './theme-preview';

export const SYSTEM_THEME_ID = 'system';
/** The standard Dark. (The id from before there was a Light: a stored choice still means it.) */
export const DARK_THEME_ID = 'default';
export const LIGHT_THEME_ID = 'light';
/** What following the desktop's theme was stored as before it became Follow system. */
const FORMER_FOLLOW_OMARCHY_ID = 'omarchy';
const BUNDLED_PREFIX = 'theme:';
/** The standard Dark's page background (the page's own sheet). */
const STANDARD_DARK_BACKGROUND = '#1f1f1f';

/** The desktop's current Omarchy theme, as the host reports it. */
export interface OmarchyThemeReport {
    /** The theme's slug (`theme.name` in Omarchy's state), e.g. tokyo-night. */
    name: string;
    palette: OmarchyPalette;
    /** Omarchy's own rendering of its VS Code theme (`theme/vscode-theme.json`), when it has one. */
    vscodeTheme?: VscodeColorTheme;
}

/** What the host knows of the computer it is on. */
export interface ThemeHost {
    /** The desktop's Omarchy theme: only the desktop app on Omarchy has one. */
    omarchy?: OmarchyThemeReport;
    /** The computer's light or dark setting (`prefers-color-scheme`). */
    systemDark: boolean;
    /** The computer's accent colour, #rrggbb: only where the host can read one. */
    accent?: string;
    /**
     * VS Code: Follow system is VS Code's own theme, which DBMN's panels wear as VS Code gives it;
     * any other theme goes over it on DBMN's panels only. Its colours, as the panels read them,
     * draw Follow system's card in the picker.
     */
    editor?: { tokens: ThemeTokens; dark: boolean };
}

/** What the user has picked, as the host stores it (any of them may never have been picked). */
export interface StoredThemeChoice {
    theme?: string;
    /** For Follow system, where the computer only says light or dark: which theme each means. */
    light?: string;
    dark?: string;
}
export type ThemeChoice = Required<StoredThemeChoice>;

export interface ThemeOption {
    id: string;
    label: string;
}

/** Settings › UI › Theme, as the Hub shows it. */
export interface ThemeMenu {
    /** Before the groups: Follow system. */
    options: ThemeOption[];
    groups: Array<{ label: string; options: ThemeOption[] }>;
    current: string;
    /** Which themes Follow system switches between, where it is the user's to say; else null. */
    system: { light: { options: ThemeOption[]; current: string }; dark: { options: ThemeOption[]; current: string } } | null;
    help: string;
    /** Each option's mock screen for the theme picker, by id; Follow system's is what it is now. */
    previews: Record<string, ThemePreview>;
}

const bundled = (mode: 'light' | 'dark'): ThemeOption[] => OMARCHY_THEMES
    .filter(theme => theme.palette.mode === mode)
    .map(theme => ({ id: BUNDLED_PREFIX + theme.slug, label: omarchyThemeName(theme.slug) }));

/** The light themes and the dark ones, the standard one first. */
export function lightThemes(): ThemeOption[] {
    return [{ id: LIGHT_THEME_ID, label: 'Light' }, ...bundled('light')];
}
export function darkThemes(): ThemeOption[] {
    return [{ id: DARK_THEME_ID, label: 'Dark' }, ...bundled('dark')];
}

/** Stored picks that still mean something; Follow system, and the standard themes, for the rest. */
export function normaliseThemeChoice(stored: StoredThemeChoice): ThemeChoice {
    const known = (id: string | undefined, among: ThemeOption[]) => !!id && among.some(option => option.id === id);
    const theme = stored.theme === FORMER_FOLLOW_OMARCHY_ID ? SYSTEM_THEME_ID : stored.theme;
    return {
        theme: theme && (theme === SYSTEM_THEME_ID || known(theme, lightThemes()) || known(theme, darkThemes())) ? theme : SYSTEM_THEME_ID,
        light: known(stored.light, lightThemes()) ? stored.light! : LIGHT_THEME_ID,
        dark: known(stored.dark, darkThemes()) ? stored.dark! : DARK_THEME_ID
    };
}

/** What Settings offers on this host, and what is chosen. */
export function themeMenu(choice: ThemeChoice, host: ThemeHost): ThemeMenu {
    const followsDesktop = !!host.omarchy;
    const followsSetting = choice.theme === SYSTEM_THEME_ID && !followsDesktop && !host.editor;
    return {
        options: [{ id: SYSTEM_THEME_ID, label: 'Follow system' }],
        groups: [{ label: 'Light', options: lightThemes() }, { label: 'Dark', options: darkThemes() }],
        current: choice.theme,
        system: followsSetting
            ? { light: { options: lightThemes(), current: choice.light }, dark: { options: darkThemes(), current: choice.dark } }
            : null,
        help: host.editor
            ? 'DBMN\'s theme in this VS Code. Follow system wears VS Code\'s theme; any other colours DBMN\'s panels, not the rest of VS Code.'
            : followsDesktop
                ? `This device's theme. Follow system keeps up with your desktop's theme (${omarchyThemeName(host.omarchy!.name)}).`
                : 'This device\'s theme. Follow system switches between your light and dark themes when your computer does.',
        previews: Object.fromEntries([SYSTEM_THEME_ID, ...lightThemes().map(option => option.id), ...darkThemes().map(option => option.id)]
            .map(id => [id, id === SYSTEM_THEME_ID && host.editor
                ? previewOf({ tokens: host.editor.tokens, kind: host.editor.dark ? 'vscode-dark' : 'vscode-light' })
                : previewOf(resolveTheme({ ...choice, theme: id }, host))]))
    };
}

/** The theme a choice comes to on this host: Follow system settled, the rest as chosen. */
export function chosenThemeId(choice: ThemeChoice, host: ThemeHost): string {
    if (choice.theme !== SYSTEM_THEME_ID) return choice.theme;
    if (host.omarchy || host.editor) return SYSTEM_THEME_ID;
    return host.systemDark ? choice.dark : choice.light;
}

/**
 * The tokens for a choice, or undefined for the page's own colours: the standard Dark, as the
 * page's sheet has it, outside VS Code; VS Code's theme, as VS Code gives it, inside.
 */
export function resolveTheme(choice: ThemeChoice, host: ThemeHost): ResolvedTheme | undefined {
    const id = chosenThemeId(choice, host);
    if (id === SYSTEM_THEME_ID) {
        if (host.editor) return undefined;
        return host.omarchy ? tokensFromVscodeTheme(host.omarchy.vscodeTheme ?? renderVscodeTheme(host.omarchy.palette)) : undefined;
    }
    if (id === LIGHT_THEME_ID) {
        const accent = host.accent ? accentTokens(host.accent, 'light', STANDARD_LIGHT_TOKENS['--vscode-editor-background']) : {};
        return { tokens: { ...STANDARD_LIGHT_TOKENS, ...accent }, kind: 'vscode-light' };
    }
    if (id === DARK_THEME_ID) {
        const accent = host.accent ? accentTokens(host.accent, 'dark', STANDARD_DARK_BACKGROUND) : {};
        // In VS Code the page's own colours are VS Code's: the standard Dark goes on in full
        const base = host.editor ? STANDARD_DARK_TOKENS : {};
        return Object.keys(base).length + Object.keys(accent).length ? { tokens: { ...base, ...accent }, kind: 'vscode-dark' } : undefined;
    }
    const theme = OMARCHY_THEMES.find(candidate => BUNDLED_PREFIX + candidate.slug === id);
    return theme ? tokensFromVscodeTheme(renderVscodeTheme(theme.palette)) : undefined;
}
