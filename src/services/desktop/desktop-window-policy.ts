// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #392: what the desktop app's window may do, decided here so the host (desktop/src/main.ts)
 * only wires it and every rule is tested without Electron.
 *
 * The window shows the app's own pages and nothing else: it never navigates away, never opens
 * another window, and is granted only the permissions the app uses. A link out goes to the
 * user's browser, and only to DBMN's own sites.
 */

/** A dev build loads the web app's dev server, on this computer only. */
export function devAppOrigin(value: string | undefined): string {
    const origin = (value ?? 'http://127.0.0.1:5180').replace(/\/+$/, '');
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) {
        throw new Error(`Refusing ${origin}: a dev build of the desktop app only loads a dev server on http://127.0.0.1.`);
    }
    return origin;
}

/** The desktop app's own pages, in a packaged build: bundled files behind this scheme, never `file://` and never a remote page. */
export const DESKTOP_SCHEME = 'dbmn-app';
export const BUNDLED_APP_ORIGIN = `${DESKTOP_SCHEME}://app`;

/** Scheme and host (`URL.origin` is "null" for a scheme of our own). */
function originOf(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        return ['http:', 'https:', `${DESKTOP_SCHEME}:`].includes(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The bundled file a page asks for, relative to the bundle's folder: `index.html` for the root.
 * Nothing outside the folder can be named: the URL parser has already folded `..`, and anything
 * odd left in a segment is refused.
 */
export function bundledPagePath(url: string): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (`${parsed.protocol}//${parsed.host}` !== BUNDLED_APP_ORIGIN) return undefined;
    let segments: string[];
    try {
        segments = parsed.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
    } catch {
        return undefined;
    }
    if (segments.some(segment => segment === '.' || segment === '..' || /[\\/\0:]/.test(segment))) return undefined;
    return segments.length === 0 ? 'index.html' : segments.join('/');
}

/** The app's own pages (the Hub, sign-in): the only places the window goes. */
export function isAppPage(url: string, appOrigin: string): boolean {
    return originOf(url) === appOrigin;
}

const DBMN_SITES = new Set(['https://dbmn.io', 'https://www.dbmn.io', 'https://app.dbmn.io']);

/** A link that leaves the app opens in the user's browser: DBMN's sites; a dev build's local site too. */
export function opensInBrowser(url: string, devSiteOrigin?: string): boolean {
    const origin = originOf(url);
    if (!origin) return false;
    if (origin.startsWith(`${DESKTOP_SCHEME}:`)) return false;
    return DBMN_SITES.has(origin) || (devSiteOrigin !== undefined && origin === devSiteOrigin);
}

/** Copy and paste (New Endpoint from Clipboard, Copy buttons). Everything else is refused. */
const PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);

export function permissionAllowed(permission: string, requestingUrl: string | undefined, appOrigin: string): boolean {
    return PERMISSIONS.has(permission) && requestingUrl !== undefined && isAppPage(requestingUrl, appOrigin);
}

/**
 * A dev-channel build says which backend it is on (CLAUDE.md "Always visible"): the Hub page
 * is bundled with the pill and its note left as placeholders, and the app fills them as it
 * serves the page, from the backend it actually hands the page.
 */
export function fillBackendPill(hubHtml: string, backend: { profile: string; apiUrl: string }): string {
    const safe = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
    const label = `DESKTOP · ${safe(backend.profile.toUpperCase())}`;
    const pill = `<span class="hub-dev-backend is-local" title="DBMN desktop app (dev build). Backend: ${safe(backend.apiUrl)}">${label}</span>`;
    const note = `<p class="hub-dev-backend-note">${pill} Backend <code>${safe(backend.apiUrl)}</code>. This build only talks to a local stack.</p>`;
    return hubHtml.split('{{DEV_BACKEND_PILL}}').join(pill).split('{{DEV_BACKEND_NOTE}}').join(note);
}
