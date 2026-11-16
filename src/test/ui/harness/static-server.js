#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/*
 * Minimal static server for the UI test harness. Started by Playwright's
 * `webServer` (see playwright.config.ts). Serves:
 *
 *   /webviews/<path>   → src/webviews/<path>   (the real CSS/JS/HTML/SVG)
 *   /harness/<path>    → src/test/ui/harness/<path>  (theme token sheet)
 *   /healthz           → 200 "ok"
 *
 * The page routes themselves (/hub, /endpoint, /environment) are fulfilled
 * by the Playwright fixture via page.route() because they need the per-test
 * seed to substitute template placeholders — see harness/fixtures.ts.
 *
 * Plain Node, no dependencies, no TypeScript so Playwright can spawn it
 * directly without a compile step.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, fallback) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(arg('--port', process.env.DBMN_UI_PORT || 4173));
const ROOT = path.resolve(__dirname, '../../../..');
const MOUNTS = {
    '/webviews/': path.join(ROOT, 'src', 'webviews'),
    '/harness/': __dirname
};

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json'
};

function send(res, status, body, type) {
    res.writeHead(status, {
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/healthz') {
        return send(res, 200, 'ok');
    }

    const prefix = Object.keys(MOUNTS).find(p => pathname.startsWith(p));
    if (!prefix) {
        return send(res, 404, `Not found: ${pathname}`);
    }

    const rel = pathname.slice(prefix.length);
    const base = MOUNTS[prefix];
    const file = path.resolve(base, rel);
    // Directory-traversal guard: the resolved path must stay inside the mount.
    if (!file.startsWith(base + path.sep) && file !== base) {
        return send(res, 403, 'Forbidden');
    }

    fs.readFile(file, (err, data) => {
        if (err) {
            return send(res, err.code === 'ENOENT' ? 404 : 500, `${err.code}: ${pathname}`);
        }
        send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[ui-harness] static server on http://127.0.0.1:${PORT} (webviews → ${MOUNTS['/webviews/']})`);
});
