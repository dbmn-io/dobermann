/**
 * The web app's security headers (#372, #380): the one place the Content Security Policy is
 * written. The production build writes them for its host (`_headers`), and the built site's
 * test server sends them (`vite preview`, web/vite.config.ts), so the e2e runs under the policy
 * users get.
 *
 * Why a CSP: the browser vault's key can't be read, but any script injected into the page can
 * use it. The policy lets only the app's own scripts run: no inline script or handler but the
 * Hub's first script (by hash), nothing from elsewhere but Monaco at its pinned version.
 *
 * What it allows, and why:
 *   script-src   'self', Monaco's pinned CDN path, the Hub's BOOTSTRAP (by hash), WebAssembly (sql.js)
 *   style-src    'self', Monaco's CDN path, and inline styles (the screens set them; a style can't run code)
 *   connect-src  any https API and the local agent on this device: the user's APIs are the point
 *   frame-src    the tabs (blob: documents of this origin)
 *   worker-src   Monaco's workers (blob:/data:)
 *   and nothing else: no plugins, no <base>, forms post only here, no one frames the app.
 */
import { createHash } from 'node:crypto';
import { BOOTSTRAP } from './shell-config';

/** Monaco, as the editor and Console load it (src/webviews/endpoint/endpoint.html, console.html). */
export const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/';

const sha256 = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

export function contentSecurityPolicy(): string {
    return [
        "default-src 'self'",
        `script-src 'self' ${MONACO} ${sha256(BOOTSTRAP)} 'wasm-unsafe-eval' 'report-sample'`,
        `style-src 'self' 'unsafe-inline' ${MONACO}`,
        `font-src 'self' data: ${MONACO}`,
        "img-src 'self' data: blob:",
        "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
        "frame-src 'self' blob:",
        "worker-src 'self' blob: data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');
}

/** The headers, by name. `reportOnly`: the browser reports what the policy would block, and blocks nothing. */
export function securityHeaders(options: { reportOnly?: boolean } = {}): Record<string, string> {
    return {
        [options.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy']: contentSecurityPolicy(),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
}
