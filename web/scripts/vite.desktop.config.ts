/**
 * The desktop app's pages (#392; the static half of #380). `npm --prefix web run build:desktop`
 * writes web/dist-desktop/: a static tree the desktop app (desktop/) serves from the root of its
 * own origin (dbmn-app://app/). No server, no Vite client, `import.meta.env.DEV` false.
 *
 * The contract with desktop/ (2026-10-11):
 *   /index.html            the Hub, as hubPage() builds it; BOOTSTRAP is the first thing in <head>
 *   /signin.html           sign in;  /oauth-callback.html  where an OAuth provider sends the browser back
 *   /webviews/**           the screens' own CSS, JS, HTML and icons (src/webviews)
 *   /theme.css /favicon.svg /signin.css
 *   /assets/**             the built entries and what they import (the sql.js wasm among them)
 *   Every URL is root-relative. NO /backend.js and no script tag for it: the page's backend comes
 *   from `window.dbmnDesktop.backend` ({profile, apiUrl, anonKey, siteUrl}), put there by the
 *   desktop app's preload before any page script runs (web/src/backend.ts reads it).
 *
 * The backend pill and note are NOT baked: index.html keeps the template's `{{DEV_BACKEND_PILL}}`
 * and `{{DEV_BACKEND_NOTE}}`, and the desktop app's scheme handler fills them from the backend its
 * main process actually uses (dev stack, or the test stack under e2e), so the pill never lies.
 *
 * Channel: DBMN_DESKTOP_CHANNEL=dev is the only one for now: a dev-channel package talks to a local
 * stack. A production channel waits on the web production build and the Supabase deploy gate
 * (#380, #388); anything but `dev` is refused.
 *
 * How: the shared static build (static-build.ts), plus this export's own checks: the pill's
 * placeholders, and no dev stack address baked in.
 */
import path from 'node:path';
import { defineConfig } from 'vite';
import { LOCAL_DEFAULTS, LOCAL_DEMO_ANON_KEY, devStackBackend } from '../../src/services/dbmn-backend/backend-config';
import { NOTE_PLACEHOLDER, PILL_PLACEHOLDER, webDir } from './shell-config';
import { staticBuildConfig } from './static-build';

const CHANNELS = ['dev'] as const;
type Channel = typeof CHANNELS[number];

function readChannel(): Channel {
    const value = process.env.DBMN_DESKTOP_CHANNEL;
    if (value !== 'dev') {
        throw new Error(`DBMN_DESKTOP_CHANNEL must be "dev" (the only channel for now: a production channel waits on #380 and #388), not "${value ?? ''}".`);
    }
    return value;
}
const channel: Channel = readChannel();

/**
 * The dev channel's nominal backend. Nothing of it reaches the output: the pill and note stay
 * placeholders, and the running app gets its backend from the desktop app's preload.
 */
const backend = devStackBackend({ profile: 'local', apiUrl: LOCAL_DEFAULTS.apiUrl, anonKey: LOCAL_DEMO_ANON_KEY, siteUrl: LOCAL_DEFAULTS.siteUrl });

export default defineConfig(staticBuildConfig({
    name: 'desktop export',
    staging: path.join(webDir, '.desktop-build'),
    outDir: path.join(webDir, 'dist-desktop'),
    backend,
    markup: 'placeholders',
    baked: null,
    checkPage(page, html, problems) {
        if (page !== 'index.html') return;
        for (const placeholder of [PILL_PLACEHOLDER, NOTE_PLACEHOLDER]) {
            if (html.split(placeholder).length !== 2) problems.push(`index.html: ${placeholder} must appear exactly once (the desktop app fills it)`);
        }
        if (html.includes(backend.apiUrl)) problems.push(`index.html: the dev stack's address ${backend.apiUrl} is baked in (the pill and note are the desktop app's to fill)`);
    },
    record: { channel, backendPill: 'placeholders: {{DEV_BACKEND_PILL}} and {{DEV_BACKEND_NOTE}} in index.html, filled by the desktop app' }
}, 'dbmn-desktop-build.json'));
