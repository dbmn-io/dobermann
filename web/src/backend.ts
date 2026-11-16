// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/// <reference types="vite/client" />
/**
 * The page's DBMN backend, decided once (#377, Architecture-v2.md 2.2). Core's backend-config is
 * the one source of truth; this is the web app's `initBackend(...)` step, and the ONLY reader of
 * what the dev server hands a page (`/backend.js`, `window.__DBMN_BACKEND__`).
 *
 * Every page's entry imports this FIRST (`import './backend'`), so it has run before any other
 * module is evaluated; everything else asks core's `getBackend()`.
 *
 * A production bundle has no dev server: `import.meta.env.DEV` is false at build time, the read
 * is dropped from the bundle, nothing is baked in, and the backend is production and nothing else. The page refuses to
 * run when "this is app.dbmn.io" and "the backend is production" disagree (resolveWebBackend).
 */
import { DESKTOP_APP_PROTOCOL, initBackend, resolveDesktopBackend, resolveWebBackend, type DevStackInput } from '../../src/services/dbmn-backend/backend-config';

// A built bundle has no dev server; a local or test build of it (vite.web.config.ts) has its stack
// baked in instead, and devStackBackend refuses anything but 127.0.0.1 all the same
const devServer = import.meta.env.DEV
    ? (window as unknown as { __DBMN_BACKEND__?: DevStackInput }).__DBMN_BACKEND__ ?? {}
    : __DBMN_BAKED_BACKEND__ ?? undefined;

try {
    // #392: a packaged desktop app's page (its own scheme, never a web address) runs on what its
    // main process handed it; every other page is the web app
    initBackend(location.protocol === DESKTOP_APP_PROTOCOL
        ? resolveDesktopBackend((window as unknown as { dbmnDesktop?: { backend?: DevStackInput } }).dbmnDesktop?.backend)
        : resolveWebBackend({ hostname: location.hostname, devServer }));
} catch (error) {
    // Refused: say why where the page would have been, and run nothing (this throw stops the entry)
    const reason = error instanceof Error ? error.message : String(error);
    const show = () => {
        const notice = document.createElement('p');
        notice.id = 'dbmn-backend-refused';
        notice.setAttribute('style', 'margin: 48px auto; max-width: 560px; font: 15px/1.5 system-ui, sans-serif;');
        notice.textContent = `DBMN can't start here. ${reason}`;
        document.body.replaceChildren(notice);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
    throw error;
}
