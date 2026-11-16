/**
 * DBMN web app (#343). Serves the extension's own screens (../src/webviews) with the web host
 * (src/shell) in place of VS Code. The pages are built by the same core builders VS Code uses
 * (../src/screens/pages.ts); what they are made of is in scripts/shell-config.ts, shared with
 * the desktop export (scripts/vite.desktop.config.ts, `npm run build:desktop`).
 *
 *   /             the Hub (buildHubPage), with the host's scripts first in <head>
 *   /webviews/*   src/webviews/* (CSS, JS, HTML, icons)
 *   /theme.css    the `--vscode-*` token sheet the screens are styled with
 *   /release-notes.json  this build's version and changelog, for Home's "New in vX.Y.Z"
 *   /signin.html  sign in (password or magic link)
 *   /backend.js   which local Supabase stack: DBMN_WEB_BACKEND=local (default, `npm run dev:local`)
 *                 or test (the disposable stack, `npm run test-stack:start`). Core's backend-config
 *                 decides (devStackBackend, #377): it refuses anything but 127.0.0.1. Only this
 *                 dev server writes it; a production bundle has none and is production only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { backendLabel, type BackendConfig, type DevStackBackend } from '../src/services/dbmn-backend/backend-config';
import { securityHeaders } from './scripts/security-headers';
import { BASE_HEAD, FILES, MIME, RELEASE_NOTES_URL, bootstrapTag, devStack, hubPage, moduleTag, nodeShims, releaseNotes, repo, webviews } from './scripts/shell-config';

/** The dev server's Hub: the backend hand-over (/backend.js) runs before the shell's bootstrap and entry. */
function devHubPage(dbmnBackend: BackendConfig): string {
    return hubPage(dbmnBackend, {
        backend: {
            label: backendLabel(dbmnBackend, 'WEB'),
            title: `DBMN web app (dev). Backend: ${dbmnBackend.apiUrl}`,
            note: 'The web app only talks to a local stack.'
        },
        head: [...BASE_HEAD, '<script src="/backend.js"></script>', bootstrapTag(), moduleTag('/src/shell/main.ts')]
    });
}

function send(res: import('node:http').ServerResponse, file: string): void {
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
}

function dbmnScreens(): Plugin {
    return {
        name: 'dbmn-screens',
        configureServer(server) {
            const dbmnBackend = devStack(process.env.DBMN_WEB_BACKEND || 'local', 'DBMN_WEB_BACKEND');
            server.config.logger.info(`  DBMN backend: ${dbmnBackend.profile} (${dbmnBackend.apiUrl})`);
            server.middlewares.use((req, res, next) => {
                const url = decodeURIComponent((req.url || '/').split('?')[0]);
                if (url === '/backend.js') {
                    res.setHeader('Content-Type', MIME['.js']);
                    // Only what a dev server decides; the page checks it again (resolveWebBackend)
                    const { profile, apiUrl, anonKey, siteUrl }: DevStackBackend = dbmnBackend;
                    res.end(`window.__DBMN_BACKEND__ = ${JSON.stringify({ profile, apiUrl, anonKey, siteUrl })};`);
                    return;
                }
                if (url === '/' || url === '/index.html') {
                    // Through Vite's HTML pipeline, so /src/shell/main.ts gets its dev client
                    void server.transformIndexHtml(url, devHubPage(dbmnBackend)).then(html => {
                        res.setHeader('Content-Type', MIME['.html']);
                        res.end(html);
                    }, next);
                    return;
                }
                if (FILES[url]) {
                    send(res, FILES[url]);
                    return;
                }
                if (url === RELEASE_NOTES_URL) {
                    res.setHeader('Content-Type', MIME['.json']);
                    res.end(releaseNotes());
                    return;
                }
                if (url.startsWith('/webviews/')) {
                    const file = path.join(webviews, url.slice('/webviews/'.length));
                    if (file.startsWith(webviews) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                        send(res, file);
                        return;
                    }
                }
                next();
            });
        }
    };
}

export default defineConfig({
    root: import.meta.dirname,
    plugins: [dbmnScreens()],
    resolve: { alias: nodeShims() },
    // The dev server hands its page the backend at run time (/backend.js): nothing baked in
    define: { __DBMN_BAKED_BACKEND__: 'null' },
    // The built site (`npm run preview:test`, the e2e's built mode) under the policy users get.
    // DBMN_WEB_CSP=report: report what it would block, block nothing (while screens move off inline scripts)
    preview: { headers: securityHeaders({ reportOnly: process.env.DBMN_WEB_CSP === 'report' }) },
    // 127.0.0.1 and a port of its own: 5173 is Vite's default and other projects use it
    server: { host: '127.0.0.1', port: Number(process.env.DBMN_WEB_PORT) || 5180, strictPort: true, fs: { allow: [repo] } }
});
