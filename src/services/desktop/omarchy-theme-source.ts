// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The desktop's current Omarchy theme, read and followed from Omarchy's state (#373).
 * `omarchy theme set` stages the chosen theme into `~/.local/state/omarchy/current/theme/` and
 * writes its slug to `current/theme.name`, so the palette is `theme/colors.toml` there, Omarchy's
 * rendering of its VS Code theme is `theme/vscode-theme.json` beside it (omarchy 4.0.4; taken as
 * it is, so a user's template override counts), and a change shows as writes in `current/`. No
 * hook to install, nothing of Omarchy's to run.
 *
 * Node's file system, no Electron: the desktop app's main process wires it (desktop/src/main.ts).
 * Where there is no Omarchy state (any other computer), there is no theme to report.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseColorsToml } from '../theme/omarchy-palette';
import { vscodeColorThemeSchema, type VscodeColorTheme } from '../theme/omarchy-vscode-theme';
import type { OmarchyThemeReport } from '../theme/theme-choice';

export interface OmarchyThemeSource {
    /** The current theme, or undefined where there is none (or it can't be read). */
    current(): Promise<OmarchyThemeReport | undefined>;
    /** Calls `listener` with each theme the desktop changes to. Returns the way to stop. */
    watch(listener: (theme: OmarchyThemeReport | undefined) => void): () => void;
}

export interface OmarchyThemeSourceOptions {
    /** Omarchy's `current` state directory (default: ~/.local/state/omarchy/current). */
    stateDir?: string;
    homeDir: string;
    log?: (message: string, error?: unknown) => void;
    /** How long after the last write in the directory the theme is re-read (ms). */
    settleMs?: number;
}

export function omarchyStateDir(homeDir: string): string {
    return path.join(homeDir, '.local', 'state', 'omarchy', 'current');
}

export function omarchyThemeSource(options: OmarchyThemeSourceOptions): OmarchyThemeSource {
    const dir = options.stateDir ?? omarchyStateDir(options.homeDir);
    const log = options.log ?? (() => undefined);
    const settleMs = options.settleMs ?? 150;

    const current = async (): Promise<OmarchyThemeReport | undefined> => {
        let text: string;
        try {
            text = await fs.promises.readFile(path.join(dir, 'theme', 'colors.toml'), 'utf8');
        } catch {
            return undefined;   // no Omarchy here, or no theme yet
        }
        const parsed = parseColorsToml(text);
        if (!parsed.ok) {
            log(`[theme] Omarchy's colors.toml isn't a palette: ${parsed.error}`);
            return undefined;
        }
        let name = '';
        try {
            name = (await fs.promises.readFile(path.join(dir, 'theme.name'), 'utf8')).trim();
        } catch {
            // older Omarchy: no theme.name; the palette is still good
        }
        const vscodeTheme = await renderedVscodeTheme();
        return vscodeTheme ? { name, palette: parsed.palette, vscodeTheme } : { name, palette: parsed.palette };
    };

    /** Omarchy's own vscode-theme.json, when there is one and it is a colour theme; else the bundled template renders. */
    const renderedVscodeTheme = async (): Promise<VscodeColorTheme | undefined> => {
        let text: string;
        try {
            text = await fs.promises.readFile(path.join(dir, 'theme', 'vscode-theme.json'), 'utf8');
        } catch {
            return undefined;
        }
        try {
            const parsed = vscodeColorThemeSchema.safeParse(JSON.parse(text));
            if (parsed.success) return parsed.data;
            log(`[theme] Omarchy's vscode-theme.json isn't a colour theme: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}`);
        } catch (error) {
            log("[theme] Omarchy's vscode-theme.json isn't JSON", error);
        }
        return undefined;
    };

    const watch: OmarchyThemeSource['watch'] = listener => {
        let watcher: fs.FSWatcher | undefined;
        let timer: NodeJS.Timeout | undefined;
        let last: string | undefined;
        const reread = () => {
            timer = undefined;
            void current().then(theme => {
                const key = JSON.stringify(theme ?? null);
                if (key === last) return;
                last = key;
                listener(theme);
            });
        };
        try {
            // The directory, not the file: theme-set replaces the whole theme folder
            watcher = fs.watch(dir, { persistent: false }, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(reread, settleMs);
            });
            watcher.on('error', error => log('[theme] stopped following Omarchy', error));
        } catch {
            return () => undefined;   // no state directory: nothing to follow
        }
        void current().then(theme => { last = JSON.stringify(theme ?? null); });
        return () => {
            if (timer) clearTimeout(timer);
            watcher?.close();
        };
    };

    return { current, watch };
}
