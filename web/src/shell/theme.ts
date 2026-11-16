// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #373: the theme the page wears, outside VS Code. The page's own sheet (/theme.css) is VS Code's
 * Dark Modern, the standard Dark; any other theme goes on top of it as `--vscode-*` properties on
 * the root element, which is also what the tab frames copy (hub-tabs.js's theme bootstrap) and
 * Monaco re-reads.
 *
 * The choice is this device's (localStorage), so it holds before sign-in and across accounts.
 * Until one is made the page follows the computer: in the desktop app on Omarchy the desktop's
 * theme, each change arriving through the bridge; anywhere else the computer's light or dark
 * setting, between the user's light theme and their dark one. On Windows and macOS the desktop
 * app also reports the computer's accent colour, for the standard themes.
 *
 * Every page's entry runs `startTheme()` early: the last tokens applied are kept beside the
 * choice, so the page paints in its theme at once and only then asks the bridge for news.
 *
 * In a browser the pick is also shared with dbmn.io: a `dbmn_theme` cookie on `.dbmn.io` (the
 * host's own name elsewhere, e.g. the local stack), which the site writes too. Whichever was
 * picked last wins, here when the page starts or comes back into view. The desktop app keeps
 * its own. The theme picker's first-visit hint is shown once per device, and not at all to
 * someone who has already picked.
 */
import type { ResolvedTheme } from '../../../src/services/theme/omarchy-vscode-theme';
import { normaliseAccent } from '../../../src/services/theme/system-accent';
import { normaliseThemeChoice, resolveTheme, themeMenu, type StoredThemeChoice, type ThemeChoice, type ThemeHost, type ThemeMenu } from '../../../src/services/theme/theme-choice';
import { desktopBridge } from './desktop';

const CHOICE_KEY = 'dbmn.theme';
/** Which themes Follow system switches between, where the computer only says light or dark. */
const LIGHT_KEY = 'dbmn.theme.light';
const DARK_KEY = 'dbmn.theme.dark';
const CACHE_KEY = 'dbmn.theme.applied';
/** Set once the theme picker's hint is done with: closed, followed, or a theme picked. */
const HINT_KEY = 'dbmn.theme.hintDone';
/** The pick dbmn.io and app.dbmn.io share (the site's assets/js/site-theme.js reads it too). */
const SHARED_COOKIE = 'dbmn_theme';
const SHARED_DAYS = 400;

const systemDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
/** What the user picked, if ever, and what is known of the computer. */
const stored: StoredThemeChoice = {};
const host: ThemeHost = { systemDark: systemDark?.matches ?? true };
const choice = (): ThemeChoice => normaliseThemeChoice(stored);
const listeners = new Set<() => void>();
let applied: string[] = [];

function read(key: string): string | undefined {
    try {
        return localStorage.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
}
function write(key: string, value: string | undefined): void {
    try {
        if (value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // storage refused: the theme still applies to this page
    }
}

/** The browser shares the pick with dbmn.io; the desktop app doesn't. */
const sharesPick = () => !desktopBridge() && typeof document !== 'undefined';

/** The pick as dbmn.io last left it, if it did. */
function readSharedPick(): StoredThemeChoice | undefined {
    if (!sharesPick()) return undefined;
    try {
        const raw = document.cookie.split('; ').find(part => part.startsWith(SHARED_COOKIE + '='));
        if (!raw) return undefined;
        const value: unknown = JSON.parse(decodeURIComponent(raw.slice(SHARED_COOKIE.length + 1)));
        if (!value || typeof value !== 'object') return undefined;
        const text = (key: string) => {
            const field = (value as Record<string, unknown>)[key];
            return typeof field === 'string' ? field : undefined;
        };
        return { theme: text('theme'), light: text('light'), dark: text('dark') };
    } catch {
        return undefined;
    }
}

function writeSharedPick(): void {
    if (!sharesPick()) return;
    try {
        const host = location.hostname;
        const domain = host === 'dbmn.io' || host.endsWith('.dbmn.io') ? '; Domain=.dbmn.io' : '';
        const secure = location.protocol === 'https:' ? '; Secure' : '';
        const value = encodeURIComponent(JSON.stringify({ theme: stored.theme, light: stored.light, dark: stored.dark }));
        document.cookie = `${SHARED_COOKIE}=${value}; Path=/; Max-Age=${SHARED_DAYS * 86400}; SameSite=Lax${domain}${secure}`;
    } catch {
        // cookies refused: the pick still holds on this page
    }
}

/** Takes dbmn.io's pick when it differs from this page's; true when it did. */
function takeSharedPick(): boolean {
    const shared = readSharedPick();
    if (!shared || (shared.theme === stored.theme && shared.light === stored.light && shared.dark === stored.dark)) return false;
    stored.theme = shared.theme;
    stored.light = shared.light;
    stored.dark = shared.dark;
    write(CHOICE_KEY, stored.theme);
    write(LIGHT_KEY, stored.light);
    write(DARK_KEY, stored.dark);
    write(HINT_KEY, '1');
    return true;
}

/** Puts `theme` on the page (or takes any theme off it, for the page's own sheet). */
function paint(theme: ResolvedTheme | undefined): void {
    const root = document.documentElement;
    for (const name of applied) root.style.removeProperty(name);
    applied = [];
    if (theme) {
        for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
        applied = Object.keys(theme.tokens);
    }
    const kind = theme?.kind ?? 'vscode-dark';
    const setBody = () => {
        document.body.classList.remove('vscode-dark', 'vscode-light');
        document.body.classList.add(kind);
        document.body.setAttribute('data-vscode-theme-kind', kind);
    };
    if (document.body) setBody();
    else document.addEventListener('DOMContentLoaded', setBody, { once: true });
    write(CACHE_KEY, theme ? JSON.stringify(theme) : undefined);
}

function apply(): void {
    paint(resolveTheme(choice(), host));
    listeners.forEach(listener => listener());
}

/** The page in its theme, now; then the computer's theme, as it is and as it changes. */
export function startTheme(): void {
    stored.theme = read(CHOICE_KEY);
    stored.light = read(LIGHT_KEY);
    stored.dark = read(DARK_KEY);
    const fromSite = takeSharedPick();
    const cached = fromSite ? undefined : read(CACHE_KEY);
    if (cached) {
        try {
            paint(JSON.parse(cached) as ResolvedTheme);
        } catch {
            write(CACHE_KEY, undefined);
        }
    }
    systemDark?.addEventListener('change', event => {
        host.systemDark = event.matches;
        apply();
    });
    // Back from dbmn.io, perhaps with another theme picked there
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && takeSharedPick()) apply();
    });
    const bridge = desktopBridge();
    if (!bridge) {
        apply();
        return;
    }
    bridge.onOmarchyTheme(theme => {
        host.omarchy = theme;
        apply();
    });
    bridge.onSystemAccent(accent => {
        host.accent = normaliseAccent(accent);
        apply();
    });
    void Promise.all([bridge.omarchyTheme().catch(() => undefined), bridge.systemAccent().catch(() => undefined)]).then(([theme, accent]) => {
        host.omarchy = theme;
        host.accent = normaliseAccent(accent);
        apply();
    });
}

/** What Settings offers, and which is chosen. */
export function currentThemeMenu(): ThemeMenu {
    return themeMenu(choice(), host);
}

/** The user's pick in Settings › UI. */
export function chooseTheme(id: string): void {
    stored.theme = normaliseThemeChoice({ ...stored, theme: id }).theme;
    write(CHOICE_KEY, stored.theme);
    write(HINT_KEY, '1');
    writeSharedPick();
    apply();
}

/** The user's pick of the theme Follow system wears when the computer is light, or dark. */
export function chooseSystemTheme(mode: 'light' | 'dark', id: string): void {
    stored[mode] = normaliseThemeChoice({ ...stored, [mode]: id })[mode];
    write(mode === 'light' ? LIGHT_KEY : DARK_KEY, stored[mode]);
    writeSharedPick();
    apply();
}

/** Whether the theme picker should show its hint: never once done with, nor after a pick. */
export function themeHintDue(): boolean {
    return !read(HINT_KEY) && stored.theme === undefined;
}

/** The hint was closed or followed: not again on this device. */
export function endThemeHint(): void {
    write(HINT_KEY, '1');
}

/** Called after each change (a pick, or the computer's theme moving), to refresh what shows it. */
export function onThemeChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
