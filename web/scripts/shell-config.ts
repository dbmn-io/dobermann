/**
 * What the web app's pages are made of, shared by the dev server (../vite.config.ts) and the
 * static builds (static-build.ts: the desktop export and the web app's own build): where the files are, the Hub page, the host's first
 * script, the themed scrollbars, and the Node shims core needs in a browser. Neither config
 * decides a page differently from the other: they pass different <head> scripts to the same
 * builder.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Alias } from 'vite';
import { buildHubPage } from '../../src/screens/pages';
import { devStackBackend, type BackendConfig } from '../../src/services/dbmn-backend/backend-config';

export const webDir = path.resolve(import.meta.dirname, '..');
export const repo = path.resolve(webDir, '..');
export const webviews = path.join(repo, 'src', 'webviews');

/** Static files the web app serves from outside web/, by URL. */
export const FILES: Record<string, string> = {
    '/theme.css': path.join(repo, 'src', 'test', 'ui', 'harness', 'vscode-theme.css'),
    '/favicon.svg': path.join(repo, 'images', 'Dobermann.svg')
};

export const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm'
};

/**
 * The page's first script, before any screen script: `acquireVsCodeApi` for the Hub, queueing
 * what it posts until the host (src/shell/main.ts) has loaded the catalogue.
 */
export const BOOTSTRAP = `(function () {
    var queue = window.__dbmnHostQueue = [];
    var state;
    var api = {
        postMessage: function (message) {
            var copy = JSON.parse(JSON.stringify(message));
            if (window.__dbmnShell) window.__dbmnShell.receive(copy); else queue.push(copy);
        },
        getState: function () { return state; },
        setState: function (s) { state = s; return s; }
    };
    window.acquireVsCodeApi = function () { return api; };
}());`;

/**
 * What VS Code gives every webview and a browser doesn't: themed scrollbars (the same rules
 * hub-tabs.js puts in each tab's frame). Without them: Chrome's white default.
 */
export const SCROLLBARS = [
    '::-webkit-scrollbar { width: 10px; height: 10px; }',
    '::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(120,120,120,.3)); }',
    '::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(120,120,120,.45)); }',
    '::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground, rgba(120,120,120,.6)); }',
    '::-webkit-scrollbar-track { background: transparent; }',
    '::-webkit-scrollbar-corner { background: transparent; }'
].join(' ');

/** The <head> every Hub page starts with, before the host's scripts. */
export const BASE_HEAD: readonly string[] = [
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    '<link rel="stylesheet" href="/theme.css">',
    `<style>${SCROLLBARS}</style>`
];

export const bootstrapTag = (): string => `<script>${BOOTSTRAP}</script>`;
export const moduleTag = (src: string): string => `<script type="module" src="${src}"></script>`;

/**
 * A local Supabase stack, by name: `local` (`npm run dev:local`) or `test` (the disposable stack,
 * `npm run test-stack:start`), as `supabase status` reports it. Core's devStackBackend refuses
 * anything but 127.0.0.1. `variable` names the setting it came from, for the error.
 */
export function devStack(name: string, variable: string): BackendConfig {
    if (name !== 'local' && name !== 'test') {
        throw new Error(`${variable} must be local or test, not ${name}`);
    }
    // The stack's project: this repo's supabase/ by default, or another checkout's (DBMN_STACK_WORKDIR),
    // e.g. a backend that runs more functions than the public baseline
    const workdir = path.resolve(process.env.DBMN_STACK_WORKDIR || repo);
    const [command, args] = name === 'test'
        ? ['node', [path.join(workdir, 'scripts', 'supabase-test-stack.mjs'), 'status']]
        : ['supabase', ['status', '-o', 'json', '--workdir', workdir]];
    let status: { API_URL: string; ANON_KEY: string };
    try {
        status = JSON.parse(execFileSync(command, args as string[], { encoding: 'utf8', stdio: 'pipe' }));
    } catch {
        throw new Error(name === 'test' ? `Test stack not running (${workdir})` : `Local stack not running in ${workdir}: supabase start (or set DBMN_STACK_WORKDIR)`);
    }
    // The website (Puppy School, pricing): the local site from `npm run dev:local`, as the extension's local profile
    const siteUrl = (process.env.DBMN_SITE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    return devStackBackend({ profile: name, apiUrl: status.API_URL, anonKey: status.ANON_KEY, siteUrl });
}

/** The extension's version (shown on Home), from the repo's package.json. */
export function packageVersion(): string {
    return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version as string;
}

/** The commit this build is made from, shown beside the version (#447); '' outside a checkout. */
export function buildCommit(): string {
    try {
        return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {
        return '';
    }
}

/** Where the pages find this build's release notes (web/src/shell/whats-new.ts). */
export const RELEASE_NOTES_URL = '/release-notes.json';

/**
 * This build's version and the changelog it ships with, for Home's "New in vX.Y.Z" (#348): what
 * DBMN for VS Code reads from its own package (hub-manager.ts), as one file the pages fetch.
 */
export function releaseNotes(): string {
    return JSON.stringify({ version: packageVersion(), changelog: fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8') });
}

/** The backend pill and note (CLAUDE.md "Always visible"), decided by the host that serves the page. */
export type HubBackendMarkup =
    | {
        /** The pill's text: WEB · LOCAL, DESKTOP · TEST, … */
        label: string;
        /** The pill's tooltip. */
        title: string;
        /** The sentence after "Backend <code>…</code>." in the note under the pill. */
        note: string;
    }
    /** Left as the template's `{{DEV_BACKEND_PILL}}` and `{{DEV_BACKEND_NOTE}}`: the server fills them when it serves the page. */
    | 'placeholders'
    /** Neither: the production web app, which users see without a dev marker. */
    | 'none';

export interface HubPageOptions {
    backend: HubBackendMarkup;
    /** Everything in <head>, in order: the host decides what runs before the shell's entry. */
    head: readonly string[];
}

export const PILL_PLACEHOLDER = '{{DEV_BACKEND_PILL}}';
export const NOTE_PLACEHOLDER = '{{DEV_BACKEND_NOTE}}';

/** The pill and its note, as hub-manager's devBackendMarkup shapes them. */
export function backendMarkup(backend: BackendConfig, markup: Exclude<HubBackendMarkup, 'placeholders' | 'none'>): { DEV_BACKEND_PILL: string; DEV_BACKEND_NOTE: string } {
    const pill = `<span class="hub-dev-backend is-local" title="${markup.title}">${markup.label}</span>`;
    return { DEV_BACKEND_PILL: pill, DEV_BACKEND_NOTE: `<p class="hub-dev-backend-note">${pill} Backend <code>${backend.apiUrl}</code>. ${markup.note}</p>` };
}

/** The Hub page as the core builder makes it, with this host's <head> in front. */
export function hubPage(backend: BackendConfig, options: HubPageOptions): string {
    // A placeholder filled with itself stays a placeholder (fillTemplate is split/join)
    const markup = options.backend === 'placeholders'
        ? { DEV_BACKEND_PILL: PILL_PLACEHOLDER, DEV_BACKEND_NOTE: NOTE_PLACEHOLDER }
        : options.backend === 'none'
            ? { DEV_BACKEND_PILL: '', DEV_BACKEND_NOTE: '' }
            : backendMarkup(backend, options.backend);
    const html = buildHubPage(fs.readFileSync(path.join(webviews, 'hub', 'hub.html'), 'utf8'), rel => `/webviews/${rel}`, undefined, markup, packageVersion(), buildCommit());
    return html.replace(/<head>/i, `<head>\n${options.head.join('\n')}`).replace(/<title>[^<]*<\/title>/i, '<title>Dobermann</title>');
}

/** Core's Node built-ins, in the browser: files in memory and IndexedDB (web/src/shell/node). */
export function nodeShims(): Alias[] {
    const shim = (name: string) => path.join(webDir, 'src', 'shell', 'node', name);
    return [
        { find: /^fs\/promises$/, replacement: shim('fs-promises.ts') },
        { find: /^fs$/, replacement: shim('fs.ts') },
        { find: /^path$/, replacement: shim('path.ts') }
    ];
}
