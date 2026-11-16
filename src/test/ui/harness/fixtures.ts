// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Playwright fixture for the webview UI tests.
 *
 *   import { test, expect } from '../harness/fixtures';
 *
 *   test('hub lists endpoints', async ({ dbmn, page }) => {
 *       await dbmn.openHub();
 *       await expect(page.locator('#catalogueList')).toContainText('Test API Endpoint');
 *   });
 *
 * `dbmn` serves the real webview HTML (with placeholders substituted the way
 * the extension's managers do — see template.js) behind a fake VS Code host
 * (fake-host.js) seeded from fixtures/seed.ts. One view per test: call
 * exactly one of openHub / openEndpointEditor / openEnvironmentEditor.
 */
import { test as base, expect, type FrameLocator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { makeSeed, type Seed } from '../fixtures/seed';

interface TemplateModule {
    buildHub(template: string, assetBase: string, initialState: unknown): string;
    buildEndpoint(template: string, assetBase: string, endpoint: unknown, opts: ViewConfig): string;
    buildEnvironment(template: string, assetBase: string, environment: unknown, opts: ViewConfig): string;
    applyThemeContext(html: string, themeHref: string, kind: ThemeKind): string;
}
// UMD module shared with the browser side; see template.js.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DbmnTemplate = require('./template.js') as TemplateModule;

export type ThemeKind = 'dark' | 'light';
export type HostView = 'hub' | 'endpoint' | 'environment';

export interface ViewConfig {
    context?: HostView;
    itemId?: string;
    defaultFolder?: string;
    duplicateFromId?: string;
}

export interface SentMessage {
    /** Tab id when the message came out of an embedded editor tab. */
    tabId: string | null;
    message: { type: string } & Record<string, unknown>;
    at: number;
}

interface FakeHostGlobal {
    sent: SentMessage[];
    received: SentMessage[];
    state(): Seed;
    push(message: Record<string, unknown>): void;
    pushToTab(tabId: string, message: Record<string, unknown>): void;
    tabs(): string[];
}

type FakeHostWindow = Window & { __dbmnFakeHost?: FakeHostGlobal; __DBMN_FAKE_HOST__?: unknown };

const HARNESS_DIR = __dirname;
const WEBVIEWS_DIR = path.resolve(HARNESS_DIR, '../../../webviews');
const TEMPLATE_FILES: Record<HostView, string> = {
    hub: 'hub/hub.html',
    endpoint: 'endpoint/endpoint.html',
    environment: 'environment/environment.html'
};

function readTemplate(view: HostView): string {
    return fs.readFileSync(path.join(WEBVIEWS_DIR, TEMPLATE_FILES[view]), 'utf8');
}

export class DbmnHarness {
    /** Mutate before calling an open* method to change the seeded world. */
    seed: Seed = makeSeed();
    theme: ThemeKind = 'dark';
    /** Abort any request that leaves the harness (anything not 127.0.0.1).
     *  Monaco — the only external asset the webviews load — is served from
     *  node_modules instead (see routeMonacoLocally), so a run is hermetic
     *  and a new external dependency shows up as a failing test. Set
     *  DBMN_UI_ALLOW_NETWORK=1 to let such requests through. */
    blockExternal = process.env.DBMN_UI_ALLOW_NETWORK !== '1';

    private opened: HostView | null = null;
    /** While set, the editor's main Monaco bundle waits for it (holdMonaco): a slow machine. */
    private monacoGate: Promise<void> | null = null;

    /**
     * Hold Monaco's main bundle back until the returned function is called, to test what the
     * user can do before the code editor is ready. Call before opening the view.
     */
    holdMonaco(): () => void {
        let release: () => void = () => undefined;
        this.monacoGate = new Promise<void>(resolve => { release = resolve; });
        return () => release();
    }

    constructor(readonly page: Page, private readonly baseURL: string) {}

    get assetBase(): string { return `${this.baseURL}/webviews`; }
    private get themeHref(): string { return `${this.baseURL}/harness/vscode-theme.css`; }

    /* ─── Opening views ─────────────────────────────────────────────── */

    /** Load the Hub. Resolves once hub.js has posted `ready` and the fake
     *  host has answered with `hubState`. */
    async openHub(): Promise<void> {
        await this.install('hub', {});
        const html = DbmnTemplate.buildHub(readTemplate('hub'), this.assetBase, null);
        await this.servePage('/hub', html);
        await this.page.goto('/hub');
        await this.waitForReceived('hubState');
    }

    /** Load the standalone endpoint editor. Omit `itemId` for "New Endpoint". */
    async openEndpointEditor(itemId?: string, opts: Omit<ViewConfig, 'context' | 'itemId'> = {}): Promise<void> {
        const config: ViewConfig = { context: 'endpoint', itemId, ...opts };
        await this.install('endpoint', config);
        const endpoint = itemId ? this.seed.endpoints.find(e => e.id === itemId) ?? null : null;
        const html = DbmnTemplate.buildEndpoint(readTemplate('endpoint'), this.assetBase, endpoint, config);
        await this.servePage('/endpoint', html);
        await this.page.goto('/endpoint');
        await this.waitForSent('ready');
    }

    /** Load the standalone environment editor. Omit `itemId` for a new one. */
    async openEnvironmentEditor(itemId?: string, opts: Omit<ViewConfig, 'context' | 'itemId'> = {}): Promise<void> {
        const config: ViewConfig = { context: 'environment', itemId, ...opts };
        await this.install('environment', config);
        const environment = itemId ? this.seed.environments.find(e => e.id === itemId) ?? null : null;
        const html = DbmnTemplate.buildEnvironment(readTemplate('environment'), this.assetBase, environment, config);
        await this.servePage('/environment', html);
        await this.page.goto('/environment');
        await this.waitForSent('ready');
    }

    /* ─── Hub tabs ──────────────────────────────────────────────────── */

    /** Locator scope for an editor tab mounted inside the Hub, e.g.
     *  `dbmn.tab('endpoint:test-endpoint-001').locator('#endpointName')`. */
    tab(tabId: string): FrameLocator {
        return this.page.frameLocator(this.tabIframeSelector(tabId));
    }

    /** Let the Hub's layout transitions (rail width, list drawer) finish, then
     *  put the page back at the top. The Hub document is taller than its
     *  viewport (#353), so a click or focus can scroll it; screenshots and
     *  clicks after a layout change need a settled, unscrolled page. The
     *  mouse is parked off the content: the list drawer closes from under the
     *  pointer, leaving it hovering whatever tab sits beneath. */
    async settle(): Promise<void> {
        await this.page.mouse.move(0, 0);
        await this.page.evaluate(async () => {
            await Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined)));
            if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
            // Home's tip of the day changes with the date, and its length moves the page under it:
            // one fixed line, so a screenshot does not depend on the day it is taken
            const tip = document.querySelector('#hubHomeTipText .hub-home-tip-line');
            if (tip) tip.textContent = 'A tip of the day, pinned for screenshots.';
        });
    }

    /** Wait until the tab's iframe has signalled ready (hub-tabs.js keeps it
     *  `visibility:hidden` until `__embeddedReady__`). */
    async waitForTab(tabId: string, timeout = 10_000): Promise<FrameLocator> {
        await this.page.locator(this.tabIframeSelector(tabId)).waitFor({ state: 'visible', timeout });
        return this.tab(tabId);
    }

    private tabIframeSelector(tabId: string): string {
        return `iframe.hub-tab-iframe[data-tab-id="${tabId.replace(/"/g, '\\"')}"]`;
    }

    /* ─── Host inspection ───────────────────────────────────────────── */

    /** Messages the UI posted to the host, optionally filtered. */
    async sent(type?: string, tabId?: string | null): Promise<SentMessage[]> {
        return this.page.evaluate(([t, tab]) => {
            const host = (window as FakeHostWindow).__dbmnFakeHost;
            if (!host) return [];
            return host.sent.filter(s => (!t || s.message.type === t) && (tab === undefined || s.tabId === tab));
        }, [type, tabId] as const);
    }

    /** Number of messages posted so far — pass as `after` to waitForSent
     *  to ignore earlier traffic. */
    async sentCount(): Promise<number> {
        return this.page.evaluate(() => (window as FakeHostWindow).__dbmnFakeHost?.sent.length ?? 0);
    }

    /** Wait for the UI to post a message of `type` (index >= `after`). */
    async waitForSent(type: string, opts: { tabId?: string | null; after?: number; timeout?: number } = {}): Promise<SentMessage> {
        const handle = await this.page.waitForFunction(([t, tab, after]) => {
            const host = (window as FakeHostWindow).__dbmnFakeHost;
            if (!host) return null;
            const hit = host.sent.find((s, i) => i >= (after ?? 0) && s.message.type === t
                && (tab === undefined || s.tabId === tab));
            return hit ?? null;
        }, [type, opts.tabId, opts.after] as const, { timeout: opts.timeout ?? 5_000 });
        return (await handle.jsonValue()) as SentMessage;
    }

    /** Wait for the host to have delivered a message of `type` to the UI. */
    async waitForReceived(type: string, opts: { tabId?: string | null; timeout?: number } = {}): Promise<SentMessage> {
        const handle = await this.page.waitForFunction(([t, tab]) => {
            const host = (window as FakeHostWindow).__dbmnFakeHost;
            if (!host) return null;
            const hit = host.received.find(s => s.message.type === t && (tab === undefined || s.tabId === tab));
            return hit ?? null;
        }, [type, opts.tabId] as const, { timeout: opts.timeout ?? 5_000 });
        return (await handle.jsonValue()) as SentMessage;
    }

    /** Deliver a host→webview message to the top-level page. */
    async push(message: Record<string, unknown>): Promise<void> {
        await this.page.evaluate(m => (window as FakeHostWindow).__dbmnFakeHost?.push(m), message);
    }

    /** Deliver a host→webview message into an editor tab. */
    async pushToTab(tabId: string, message: Record<string, unknown>): Promise<void> {
        await this.page.evaluate(([id, m]) => (window as FakeHostWindow).__dbmnFakeHost?.pushToTab(id, m), [tabId, message] as const);
    }

    /** Snapshot of the fake host's live store. */
    async state(): Promise<Seed> {
        return this.page.evaluate(() => {
            const host = (window as FakeHostWindow).__dbmnFakeHost;
            if (!host) throw new Error('fake host not installed');
            return JSON.parse(JSON.stringify(host.state())) as Seed;
        });
    }

    /* ─── Internals ─────────────────────────────────────────────────── */

    private async install(view: HostView, config: ViewConfig): Promise<void> {
        if (this.opened) {
            throw new Error(`dbmn harness already opened '${this.opened}' on this page; use one view per test`);
        }
        this.opened = view;

        const hostConfig = {
            view,
            config,
            seed: this.seed,
            assetBase: this.assetBase,
            templates: {
                endpoint: `${this.assetBase}/endpoint/endpoint.html`,
                environment: `${this.assetBase}/environment/environment.html`
            }
        };
        await this.page.addInitScript(c => { (window as FakeHostWindow).__DBMN_FAKE_HOST__ = c; }, hostConfig);
        await this.page.addInitScript({ path: path.join(HARNESS_DIR, 'template.js') });
        await this.page.addInitScript({ path: path.join(HARNESS_DIR, 'fake-host.js') });

        // Routes are matched last-registered-first, so register the catch-all
        // before the Monaco route.
        if (this.blockExternal) {
            await this.page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => route.abort('blockedbyclient'));
        }
        await this.routeMonacoLocally();
    }

    /** The editors load Monaco from jsDelivr (`endpoint.html`, `console.html`).
     *  Serve those URLs from the pinned `monaco-editor` devDependency so the
     *  suite needs no network and the editor version is fixed. */
    private async routeMonacoLocally(): Promise<void> {
        const monacoRoot = path.dirname(require.resolve('monaco-editor/package.json'));
        const installed = (JSON.parse(fs.readFileSync(path.join(monacoRoot, 'package.json'), 'utf8')) as { version: string }).version;
        await this.page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/monaco-editor@([^/]+)\/(.+)$/, async route => {
            const match = /\/npm\/monaco-editor@([^/]+)\/(.+)$/.exec(route.request().url());
            const version = match?.[1];
            const rel = match?.[2]?.split('?')[0];
            if (!rel || version !== installed) {
                // The webview HTML pins a different Monaco than node_modules.
                // Fall through (blocked or CDN) rather than silently serving
                // the wrong build — bump the devDependency to match.
                console.warn(`[ui-harness] monaco-editor@${version} requested but ${installed} is installed`);
                await route.fallback();
                return;
            }
            if (this.monacoGate && /editor\.main\.js$/.test(rel)) await this.monacoGate;
            const file = path.join(monacoRoot, rel);
            if (!file.startsWith(monacoRoot) || !fs.existsSync(file)) {
                await route.fulfill({ status: 404, body: `not in monaco-editor package: ${rel}` });
                return;
            }
            const types: Record<string, string> = {
                '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.json': 'application/json'
            };
            await route.fulfill({ path: file, contentType: types[path.extname(file)] ?? 'application/octet-stream' });
        });
    }

    private async servePage(pathname: string, html: string): Promise<void> {
        const body = DbmnTemplate.applyThemeContext(html, this.themeHref, this.theme);
        await this.page.route(`${this.baseURL}${pathname}`, route =>
            route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
    }
}

export const test = base.extend<{ dbmn: DbmnHarness }>({
    dbmn: async ({ page, baseURL }, use) => {
        if (!baseURL) throw new Error('playwright.config.ts must set use.baseURL');
        await use(new DbmnHarness(page, baseURL));
    }
});

export { expect };

/** Open the Hub's list drawer on one of its lists (Issue #349): the lists
 *  are hidden until their rail item is clicked. */
export async function openList(page: Page, section: 'catalogue' | 'environments' | 'transactions'): Promise<void> {
    await page.locator(`.hub-nav-item[data-section="${section}"]`).click();
    await expect(page.locator('.hub-layout')).toHaveClass(/drawer-open/);
    await expect(page.locator(`.hub-section[data-section="${section}"]`)).toBeVisible();
}
