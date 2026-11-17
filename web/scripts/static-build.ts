/**
 * A static build of the web app's pages: the desktop export (vite.desktop.config.ts) and the web
 * app's own build for app.dbmn.io (vite.web.config.ts). No server and no Vite client;
 * `import.meta.env.DEV` is false.
 *
 * What a build holds:
 *   /index.html            the Hub, as hubPage() builds it; BOOTSTRAP is the first thing in <head>
 *   /signin.html           sign in;  /oauth-callback.html  where an OAuth provider sends the browser back
 *   /webviews/**           the screens' own CSS, JS, HTML and icons (src/webviews)
 *   /theme.css /favicon.svg /signin.css /release-notes.json
 *   /assets/**             the built entries and what they import (the sql.js wasm among them)
 * Every URL is root-relative, and there is no /backend.js (the dev server's hand-over).
 *
 * How: a staging folder gets the three HTML pages and a `public/` with every static file; Vite
 * builds the pages' module entries from there and copies `public/` through untouched. After the
 * build, the output is checked (every URL it references exists, nothing of the dev server in it,
 * plus the build's own checks) and a build record is written; the staging folder is removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, UserConfig } from 'vite';
import type { BackendConfig } from '../../src/services/dbmn-backend/backend-config';
import {
    BASE_HEAD, FILES, RELEASE_NOTES_URL, bootstrapTag, buildCommit, hubPage, moduleTag, nodeShims, packageVersion, releaseNotes, repo, webDir, webviews,
    type HubBackendMarkup
} from './shell-config';

export interface StaticBuild {
    /** For messages: "desktop export", "web build". */
    name: string;
    /** web/<staging> while building, removed after. */
    staging: string;
    outDir: string;
    /** The backend the Hub page is built against (its pill and note, when `markup` asks for them). */
    backend: BackendConfig;
    markup: HubBackendMarkup;
    /**
     * Baked into the bundle as `__DBMN_BAKED_BACKEND__` (web/src/backend.ts): a local or test
     * stack the built pages run on. null for a bundle with no baked stack: production for the
     * web app, the preload's backend for the desktop app.
     */
    baked: Pick<BackendConfig, 'profile' | 'apiUrl' | 'anonKey' | 'siteUrl'> | null;
    /** This build's own checks of a built page, after the shared ones. */
    checkPage?: (page: string, html: string, problems: string[]) => void;
    /** This build's own checks of a built script. */
    checkScript?: (script: string, code: string, problems: string[]) => void;
    /** Written to the build record. */
    record: Record<string, unknown>;
    /** More files for the output, by path: what the host reads (the web build's `_headers`). */
    files?: Record<string, string>;
}

const PAGES = ['index.html', 'signin.html', 'oauth-callback.html'] as const;

function copyTree(from: string, to: string): void {
    fs.cpSync(from, to, { recursive: true, dereference: true });
}

/** `text` with `from` replaced once, or an error: a page whose shape moved must not build quietly. */
function replaceOnce(text: string, from: string | RegExp, to: string, page: string): string {
    const matched = typeof from === 'string' ? text.includes(from) : from.test(text);
    if (!matched) throw new Error(`${page}: expected to find ${String(from)}`);
    return text.replace(from, to);
}

export function listFiles(dir: string, under = ''): string[] {
    return fs.readdirSync(path.join(dir, under), { withFileTypes: true }).flatMap(entry => {
        const rel = path.posix.join(under, entry.name);
        return entry.isDirectory() ? listFiles(dir, rel) : [rel];
    });
}

/** The pages and the static files, as they will be served. */
function stage(build: StaticBuild): void {
    const publicDir = path.join(build.staging, 'public');
    fs.rmSync(build.staging, { recursive: true, force: true });
    fs.mkdirSync(publicDir, { recursive: true });

    // The static files, by the URL the pages use for them
    for (const [url, file] of Object.entries(FILES)) fs.copyFileSync(file, path.join(publicDir, url.slice(1)));
    fs.writeFileSync(path.join(publicDir, RELEASE_NOTES_URL.slice(1)), releaseNotes());
    copyTree(path.join(webDir, 'public'), publicDir);
    copyTree(webviews, path.join(publicDir, 'webviews'));

    // The Hub: BOOTSTRAP first in <head>, then the base head, then the shell's entry (relative to
    // the staging folder, so Vite bundles web/src/shell/main.ts). No /backend.js.
    fs.writeFileSync(path.join(build.staging, 'index.html'), hubPage(build.backend, {
        backend: build.markup,
        head: [bootstrapTag(), ...BASE_HEAD, moduleTag('../src/shell/main.ts')]
    }));

    // Sign in: the same page as the dev server's, without its backend hand-over
    let signin = fs.readFileSync(path.join(webDir, 'signin.html'), 'utf8');
    signin = replaceOnce(signin, /[ \t]*<script src="\/backend\.js"><\/script>\r?\n/, '', 'signin.html');
    signin = replaceOnce(signin, 'src="/src/signin.ts"', 'src="../src/signin.ts"', 'signin.html');
    fs.writeFileSync(path.join(build.staging, 'signin.html'), signin);

    // The OAuth callback page has no backend and no module: as it is
    const callback = fs.readFileSync(path.join(webDir, 'oauth-callback.html'), 'utf8');
    if (callback.includes('/backend.js')) throw new Error('oauth-callback.html: unexpected /backend.js');
    fs.writeFileSync(path.join(build.staging, 'oauth-callback.html'), callback);
}

/** The output holds together, and nothing of the dev server is in it. */
function check(build: StaticBuild): void {
    const files = new Set(listFiles(build.outDir));
    const problems: string[] = [];
    for (const required of [...PAGES, 'theme.css', 'favicon.svg', 'signin.css', RELEASE_NOTES_URL.slice(1),
        'webviews/hub/hub.html', 'webviews/hub/hub.js', 'webviews/shared/core.css', 'webviews/environment/environment.js', 'webviews/endpoint/endpoint.js']) {
        if (!files.has(required)) problems.push(`missing ${required}`);
    }
    if (![...files].some(f => f.startsWith('assets/') && f.endsWith('.wasm'))) problems.push('missing the sql.js wasm under assets/');

    // Every URL a page references is in the tree, and root-relative (the pages are the three at
    // the root; webviews/**.html are the screens' templates, filled by the shell at run time)
    for (const page of PAGES.filter(f => files.has(f))) {
        const html = fs.readFileSync(path.join(build.outDir, page), 'utf8');
        for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
            const url = match[1];
            if (/^(?:https?:)?\/\//.test(url)) { problems.push(`${page}: absolute URL ${url}`); continue; }
            if (url.startsWith('data:') || url.startsWith('#')) continue;
            if (!url.startsWith('/')) { problems.push(`${page}: relative URL ${url} (every URL is root-relative)`); continue; }
            const file = url.slice(1).split(/[?#]/)[0];
            if (!files.has(file)) problems.push(`${page}: ${url} is not in the output`);
        }
        if (html.includes('/backend.js')) problems.push(`${page}: references /backend.js (the dev server's hand-over)`);
        if (html.includes('/@vite/')) problems.push(`${page}: Vite's dev client is in it`);
        if (page === 'index.html') {
            const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
            if (!/^<head>\s*<script>\(function \(\) \{\s*var queue = window\.__dbmnHostQueue/.test(head)) problems.push('index.html: BOOTSTRAP is not the first thing in <head>');
        }
        build.checkPage?.(page, html, problems);
    }

    // Nothing of the dev server in the built code
    for (const script of [...files].filter(f => f.startsWith('assets/') && f.endsWith('.js'))) {
        const code = fs.readFileSync(path.join(build.outDir, script), 'utf8');
        if (code.includes('/@vite/client')) problems.push(`${script}: Vite's dev client is in it`);
        if (code.includes('__DBMN_BACKEND__')) problems.push(`${script}: reads the dev server's backend hand-over (import.meta.env.DEV should have dropped it)`);
        build.checkScript?.(script, code, problems);
    }

    if (problems.length) {
        throw new Error(`The ${build.name} is not whole:\n  - ${problems.join('\n  - ')}`);
    }
}

function buildRecord(build: StaticBuild, file: string): void {
    const commit = buildCommit();
    fs.writeFileSync(path.join(build.outDir, file), JSON.stringify({
        ...build.record, version: packageVersion(), commit, builtAt: new Date().toISOString(), files: listFiles(build.outDir).length + 1
    }, null, 2) + '\n');
}

/** Vite's config for a static build: stages the pages, then checks the output and records it. */
export function staticBuildConfig(build: StaticBuild, recordFile: string): UserConfig {
    stage(build);
    const finish: Plugin = {
        name: 'dbmn-static-build',
        apply: 'build',
        closeBundle: {
            sequential: true,
            handler() {
                try {
                    check(build);
                    for (const [file, text] of Object.entries(build.files ?? {})) fs.writeFileSync(path.join(build.outDir, file), text);
                    buildRecord(build, recordFile);
                } finally {
                    fs.rmSync(build.staging, { recursive: true, force: true });
                }
                console.info(`[dbmn ${build.name}] ${build.outDir}`);
            }
        }
    };
    return {
        root: build.staging,
        publicDir: path.join(build.staging, 'public'),
        base: '/',
        plugins: [finish],
        resolve: { alias: nodeShims() },
        define: { __DBMN_BAKED_BACKEND__: JSON.stringify(build.baked), __DBMN_APP_VERSION__: JSON.stringify(packageVersion()) },
        build: {
            outDir: build.outDir,
            emptyOutDir: true,
            target: 'es2022',
            rollupOptions: {
                input: Object.fromEntries(PAGES.map(page => [page.replace(/\.html$/, ''), path.join(build.staging, page)]))
            }
        }
    };
}
