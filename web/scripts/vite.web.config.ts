/**
 * The web app's own build, for app.dbmn.io (#380). `npm --prefix web run build` writes web/dist/:
 * the static tree a host serves as the site. The shared static build (static-build.ts) makes it.
 *
 * It writes `_headers` (security-headers.ts: the CSP and the rest) for the host.
 *
 *   DBMN_WEB_BUILD_BACKEND=production (default)  web/dist. No stack baked in, no dev pill: the page
 *       runs on the production backend, and only on app.dbmn.io (web/src/backend.ts refuses
 *       anywhere else, so a copy served elsewhere runs nothing).
 *   DBMN_WEB_BUILD_BACKEND=local | test          web/dist-local, web/dist-test. The same bundle with
 *       a local stack baked in, served on 127.0.0.1, so the built site can be tested end to end
 *       without production (`npm run test:e2e:web:built`). The pill says so.
 */
import path from 'node:path';
import { defineConfig } from 'vite';
import { PRODUCTION_BACKEND, backendLabel } from '../../src/services/dbmn-backend/backend-config';
import { securityHeaders } from './security-headers';
import { devStack, webDir } from './shell-config';
import { staticBuildConfig } from './static-build';

const target = process.env.DBMN_WEB_BUILD_BACKEND || 'production';
const production = target === 'production';
const backend = production ? PRODUCTION_BACKEND : devStack(target, 'DBMN_WEB_BUILD_BACKEND');

export default defineConfig(staticBuildConfig({
    name: `web build (${target})`,
    staging: path.join(webDir, '.web-build'),
    outDir: path.join(webDir, production ? 'dist' : `dist-${target}`),
    backend,
    markup: production ? 'none' : {
        label: backendLabel(backend, 'WEB'),
        title: `DBMN web app (built, ${target}). Backend: ${backend.apiUrl}`,
        note: 'A build of the web app, on a local stack.'
    },
    baked: production ? null : { profile: backend.profile, apiUrl: backend.apiUrl, anonKey: backend.anonKey, siteUrl: backend.siteUrl },
    checkPage(page, html, problems) {
        if (!production) return;
        if (html.includes('127.0.0.1')) problems.push(`${page}: a local address is in the production build`);
        if (html.includes('hub-dev-backend')) problems.push(`${page}: the dev pill is in the production build`);
    },
    record: { app: 'web', backend: target, apiUrl: backend.apiUrl },
    // The security headers, CSP first (#372), for every path: Cloudflare Pages' `_headers` format
    // (a host that doesn't read it ignores the file). The built site's test server sends the same.
    files: { _headers: `/*\n${Object.entries(securityHeaders()).map(([name, value]) => `  ${name}: ${value}`).join('\n')}\n` }
}, 'dbmn-web-build.json'));
