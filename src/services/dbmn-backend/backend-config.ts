// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which DBMN backend this build talks to — the ONE place that decides.
 *
 * THE RULE (see CLAUDE.md → "Backends: local vs production")
 *   - A packaged build is ALWAYS production. Nothing on the user's machine can redirect it.
 *   - The Extension Development Host defaults to the LOCAL Supabase stack, and can be
 *     pointed at production on purpose with DBMN_BACKEND=production (a dev machine with
 *     no local stack). Both launch configurations set the variable explicitly.
 *   - Named profiles, never a guess: an unknown DBMN_BACKEND value throws.
 *   - NEVER a silent fallback. Local profile + stack down = signed out, with a notice that
 *     says how to fix it. Quietly using production instead is how test data ends up there.
 *   - Always visible: a dev build shows "DEV · LOCAL" or "DEV · PRODUCTION" in the Hub.
 *   - Stored sessions are separated per profile. The dev host shares secret storage with
 *     the installed extension (same extension id); without the suffix a local run would
 *     try to refresh the real production token against the local stack, fail, and sign
 *     the real extension out. Production keeps the historical key names (suffix '').
 *   - A dev build tags its telemetry and usage rows: extension_version "<version>-dev".
 *   - Issue #396: how long the last known licence is trusted without confirmation is
 *     4 weeks. A dev build can shorten it with DBMN_LICENSE_GRACE_MINUTES to test the
 *     lapse; a packaged build never reads it.
 *
 * EVERY HOST (#377, Architecture-v2.md 2.2). This file is the one source of truth for VS Code,
 * the web app and the desktop app. Each host's composition root calls `initBackend(...)` before
 * it builds any service; nothing else decides a backend.
 *   - Profiles: `local` (the dev stack), `test` (the disposable test stack), `production`.
 *   - The web app (`resolveWebBackend`): a production bundle is production and nothing else; a
 *     dev server hands the page a local stack on 127.0.0.1. The page refuses to run unless
 *     "it is app.dbmn.io" and "its backend is production" are both true or both false.
 *
 * Portable: no `vscode` import. extension.ts passes in the mode and the environment.
 */
import { DBMN_CACHE_TTL, DBMN_STORAGE_KEYS } from '../../types/dbmn-auth';

export type BackendProfile = 'local' | 'test' | 'production';

export interface BackendConfig {
    profile: BackendProfile;
    /** Supabase API base, no trailing slash. */
    apiUrl: string;
    anonKey: string;
    /** The website (account pages, docs, Puppy School), no trailing slash. */
    siteUrl: string;
    /** Appended to every stored key. '' for production. */
    storageSuffix: string;
    /** A development build: the Extension Development Host, or the web app's dev server. */
    isDevBuild: boolean;
    /** Issue #396: how long a cached licence is trusted when it cannot be confirmed. */
    licenseGraceMs: number;
}

export const PRODUCTION_BACKEND: BackendConfig = {
    profile: 'production',
    apiUrl: 'https://api.dbmn.io',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4cmZscXBraWhleXJxcGlrZmxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5ODg3MzgsImV4cCI6MjA4NzU2NDczOH0.-qC5CregIAJwZvR_NsR1Sa6h-DuPICOO3gt55fgbycU', // gitleaks:allow (the anon key is public by design: it ships in every build; row-level security guards the data)
    siteUrl: 'https://dbmn.io',
    storageSuffix: '',
    isDevBuild: false,
    licenseGraceMs: DBMN_CACHE_TTL.offlineGracePeriodMs
};

/**
 * The anon key every `supabase start` stack uses. It is a published demo constant, the same
 * on every machine, and grants nothing outside a local stack — not a secret.
 */
export const LOCAL_DEMO_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'; // gitleaks:allow (the Supabase CLI demo anon key, the same on every local stack)

export const LOCAL_DEFAULTS = {
    apiUrl: 'http://127.0.0.1:54321',
    siteUrl: 'http://127.0.0.1:4000'
} as const;

/** The disposable test stack (`npm run test-stack:start`). */
export const TEST_DEFAULTS = {
    apiUrl: 'http://127.0.0.1:54421'
} as const;

export interface ResolveBackendInput {
    /** `context.extensionMode === ExtensionMode.Development` */
    isDevelopment: boolean;
    env: Record<string, string | undefined>;
}

const stripSlash = (url: string): string => url.trim().replace(/\/+$/, '');

/** Issue #396: DBMN_LICENSE_GRACE_MINUTES, dev builds only. Unset = the 4-week default; a bad value throws. */
function resolveLicenseGraceMs(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') {
        return DBMN_CACHE_TTL.offlineGracePeriodMs;
    }
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`DBMN_LICENSE_GRACE_MINUTES must be a number of minutes greater than 0, not "${raw}"`);
    }
    return Math.round(minutes * 60 * 1000);
}

export function resolveBackend(input: ResolveBackendInput): BackendConfig {
    // A packaged (or test-host) build never reads the environment.
    if (!input.isDevelopment) {
        return PRODUCTION_BACKEND;
    }

    const requested = (input.env.DBMN_BACKEND ?? 'local').trim().toLowerCase();
    const licenseGraceMs = resolveLicenseGraceMs(input.env.DBMN_LICENSE_GRACE_MINUTES);

    if (requested === 'production') {
        return { ...PRODUCTION_BACKEND, isDevBuild: true, licenseGraceMs };
    }
    if (requested === 'local' || requested === 'test') {
        return {
            profile: requested,
            apiUrl: stripSlash(input.env.DBMN_BACKEND_URL || (requested === 'test' ? TEST_DEFAULTS : LOCAL_DEFAULTS).apiUrl),
            anonKey: (input.env.DBMN_BACKEND_ANON_KEY || LOCAL_DEMO_ANON_KEY).trim(),
            siteUrl: stripSlash(input.env.DBMN_SITE_URL || LOCAL_DEFAULTS.siteUrl),
            storageSuffix: `__${requested}`,
            isDevBuild: true,
            licenseGraceMs
        };
    }
    throw new Error(`DBMN_BACKEND must be "local", "test" or "production", not "${input.env.DBMN_BACKEND}"`);
}

// ---------------------------------------------------------------------------
// The web app (#377)
// ---------------------------------------------------------------------------

/** Where the production web app is served: the only page that talks to production. */
export const WEB_APP_HOST = 'app.dbmn.io';

/** What a dev server hands its page (`/backend.js`): unchecked until `devStackBackend` reads it. */
export interface DevStackInput {
    profile?: unknown;
    apiUrl?: unknown;
    anonKey?: unknown;
    siteUrl?: unknown;
}

/** What the page is handed: the part of the config a dev server decides. */
export type DevStackBackend = Pick<BackendConfig, 'profile' | 'apiUrl' | 'anonKey' | 'siteUrl'>;

/**
 * A dev server's backend: the `local` stack or the `test` stack, and only ever on 127.0.0.1.
 * Throws for anything else, so a dev server can't be pointed at production (or anywhere real).
 */
export function devStackBackend(input: DevStackInput): BackendConfig {
    if (input.profile !== 'local' && input.profile !== 'test') {
        throw new Error(`A dev server's DBMN backend is "local" or "test", not "${String(input.profile)}"`);
    }
    const apiUrl = typeof input.apiUrl === 'string' ? stripSlash(input.apiUrl) : '';
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl)) {
        throw new Error(`Refusing ${apiUrl || 'a missing API URL'}: a dev server only talks to a local stack (http://127.0.0.1:<port>)`);
    }
    if (typeof input.anonKey !== 'string' || !input.anonKey.trim()) {
        throw new Error('The dev server gave no anon key for its local stack');
    }
    return {
        profile: input.profile,
        apiUrl,
        anonKey: input.anonKey.trim(),
        siteUrl: stripSlash(typeof input.siteUrl === 'string' && input.siteUrl ? input.siteUrl : LOCAL_DEFAULTS.siteUrl),
        storageSuffix: `__${input.profile}`,
        isDevBuild: true,
        licenseGraceMs: DBMN_CACHE_TTL.offlineGracePeriodMs
    };
}

export interface ResolveWebBackendInput {
    /** `location.hostname` */
    hostname: string;
    /**
     * What the dev server handed this page. A production bundle passes `undefined` (it has no
     * dev server, and its build drops the read), so it can only ever be production.
     */
    devServer?: DevStackInput;
}

/**
 * The web app's backend, and the check that makes it safe: the page is app.dbmn.io exactly when
 * its backend is production. A production bundle served anywhere else, or a dev page that somehow
 * got the production backend, throws: the page shows why and runs nothing.
 */
export function resolveWebBackend(input: ResolveWebBackendInput): BackendConfig {
    const config = input.devServer ? devStackBackend(input.devServer) : PRODUCTION_BACKEND;
    const onAppHost = input.hostname === WEB_APP_HOST;
    const production = config.apiUrl === PRODUCTION_BACKEND.apiUrl;
    if (onAppHost && !production) {
        throw new Error(`${WEB_APP_HOST} only runs on the production backend, not ${config.apiUrl}.`);
    }
    if (!onAppHost && production) {
        throw new Error(`This page (${input.hostname || 'no host'}) is not ${WEB_APP_HOST}, so it will not use the production backend. For a local stack, run the web app's dev server: npm run web:dev.`);
    }
    return config;
}

// ---------------------------------------------------------------------------
// The desktop app (#392)
// ---------------------------------------------------------------------------

/** A packaged desktop app's pages are served on this scheme (desktop-window-policy.ts). */
export const DESKTOP_APP_PROTOCOL = 'dbmn-app:';

/**
 * What a dev-channel desktop build's main process hands its pages: the local stack (or the test
 * stack, for its e2e), by name only. Never an address from the environment, never production.
 */
export function desktopDevBackend(env: Record<string, string | undefined>): DevStackBackend {
    const requested = (env.DBMN_BACKEND ?? 'local').trim().toLowerCase();
    if (requested !== 'local' && requested !== 'test') {
        throw new Error(`A dev build of the desktop app runs on "local" or "test", not "${env.DBMN_BACKEND}"`);
    }
    return {
        profile: requested,
        apiUrl: (requested === 'test' ? TEST_DEFAULTS : LOCAL_DEFAULTS).apiUrl,
        anonKey: LOCAL_DEMO_ANON_KEY,
        siteUrl: LOCAL_DEFAULTS.siteUrl
    };
}

/**
 * A packaged desktop page's backend: what its main process handed it, checked again here. Today
 * that is a dev-channel build, so a local stack and nothing else (devStackBackend refuses the rest).
 * TODO(#380): a production-channel build. Its page is not app.dbmn.io, so resolveWebBackend's
 * hostname check can't vouch for it: the channel must be a build-time constant of the package,
 * production exactly when the channel is, and refused here otherwise.
 */
export function resolveDesktopBackend(handed: DevStackInput | undefined): BackendConfig {
    if (!handed) throw new Error('The desktop app gave this page no backend.');
    return devStackBackend(handed);
}

// ---------------------------------------------------------------------------
// The active backend. Set once, first thing in activation. Until then (and in unit tests)
// it is production, which is what every existing test assumes.
// ---------------------------------------------------------------------------
let active: BackendConfig = PRODUCTION_BACKEND;

export function initBackend(config: BackendConfig): void {
    active = config;
}

export function getBackend(): BackendConfig {
    return active;
}

type DbmnStorageKeyName = keyof typeof DBMN_STORAGE_KEYS;

/** DBMN_STORAGE_KEYS for the active profile. */
export function dbmnStorageKeys(): Record<DbmnStorageKeyName, string> {
    const suffix = active.storageSuffix;
    const names = Object.keys(DBMN_STORAGE_KEYS) as DbmnStorageKeyName[];
    return Object.fromEntries(names.map(name => [name, DBMN_STORAGE_KEYS[name] + suffix])) as Record<DbmnStorageKeyName, string>;
}

/**
 * "DEV · LOCAL" / "DEV · PRODUCTION" (the web app's dev server: "WEB · LOCAL" / "WEB · TEST";
 * the desktop app's dev channel: "DESKTOP · LOCAL");
 * '' in a packaged build or a production bundle, which shows nothing.
 */
export function backendLabel(config: BackendConfig = active, host: 'DEV' | 'WEB' | 'DESKTOP' = 'DEV'): string {
    return config.isDevBuild ? `${host} · ${config.profile.toUpperCase()}` : '';
}

/** What telemetry and usage rows carry as the extension version. */
export function reportedExtensionVersion(version: string, config: BackendConfig = active): string {
    return config.isDevBuild ? `${version}-dev` : version;
}

/**
 * May a webview ask the extension to open this URL in the browser? dbmn.io always (help
 * icons point at the published docs), plus the active site in a dev build.
 */
export function isAllowedExternalUrl(url: string, config: BackendConfig = active): boolean {
    return url.startsWith(`${PRODUCTION_BACKEND.siteUrl}/`) || url.startsWith(`${config.siteUrl}/`);
}

/**
 * Help links open the docs of the site this build talks to. Webviews always ask for
 * `https://dbmn.io/docs/…` (they cannot read the backend); a dev build on the local profile
 * opens the same page on the local site instead, which serves the docs written for the next
 * release — so a help link to a page that is not live yet still works in development. A
 * packaged build, or the production profile, is unchanged.
 */
export function resolveDocsUrl(url: string, config: BackendConfig = active): string {
    const prefix = `${PRODUCTION_BACKEND.siteUrl}/docs/`;
    if (config.siteUrl === PRODUCTION_BACKEND.siteUrl || !url.startsWith(prefix)) return url;
    return `${config.siteUrl}/docs/${url.slice(prefix.length)}`;
}

/**
 * The no-silent-fallback message. The local stack is unreachable: say so, say how to fix
 * it, and do NOT reach for production.
 */
export function backendUnreachableMessage(config: BackendConfig = active): string {
    return config.profile === 'local'
        ? `DEV · LOCAL backend not reachable at ${config.apiUrl}. Start it with "npm run dev:local", or launch "Run Extension (PRODUCTION backend)".`
        : '';
}

const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The always-visible marker. A packaged build gets two empty strings, so users never see
 * it. LOCAL is solid yellow (matching the website's LOCAL ribbon); PRODUCTION is the warning colour, because that is the one where a
 * careless click touches real data. Styles: hub.css (.hub-dev-backend).
 */
export function devBackendMarkup(config: BackendConfig = active): { DEV_BACKEND_PILL: string; DEV_BACKEND_NOTE: string } {
    if (!config.isDevBuild) {
        return { DEV_BACKEND_PILL: '', DEV_BACKEND_NOTE: '' };
    }
    const label = escapeHtml(backendLabel(config));
    const api = escapeHtml(config.apiUrl);
    const site = escapeHtml(config.siteUrl);
    const cls = `hub-dev-backend is-${config.profile}`;
    // Issue #396: a shortened licence grace changes when sign-in is demanded — say so.
    const grace = config.licenseGraceMs === DBMN_CACHE_TTL.offlineGracePeriodMs
        ? ''
        : ` Licence grace shortened to ${Math.round(config.licenseGraceMs / 60000)} min.`;
    return {
        DEV_BACKEND_PILL: `<span class="${cls}" title="Development build. DBMN backend: ${api}">${label}</span>`,
        DEV_BACKEND_NOTE: `<p class="hub-dev-backend-note"><span class="${cls}">${label}</span> Backend <code>${api}</code> · site <code>${site}</code>. Sessions are stored separately per backend.${grace}</p>`
    };
}

/**
 * Is the backend answering? Used ONLY to tell a developer their local stack is down — the
 * answer never changes which backend is used.
 */
export async function isBackendReachable(
    config: BackendConfig = active,
    fetchFn: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }> = fetch,
    timeoutMs = 2500
): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchFn(`${config.apiUrl}/auth/v1/health`, {
            headers: { apikey: config.anonKey },
            signal: controller.signal
        });
        return response.status < 500;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}
