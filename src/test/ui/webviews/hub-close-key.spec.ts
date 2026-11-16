// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect } from '../harness/fixtures';
import type { Page } from '@playwright/test';

// Alt+W closes the active tab in every DBMN. A browser keeps Ctrl+W for itself (it closes the
// whole page), so the web app can't have it; VS Code keeps Ctrl+W as well. Inside a tab the
// frame catches the key (tab-frame.js); on the Hub page VS Code's contributed keybinding
// sends closeActiveTabFromHost, and the web and desktop apps catch it on the page.
test.describe('Alt+W closes the active tab', () => {
    const clean = (name: string) => `<!DOCTYPE html><html><head><title>${name}</title></head><body><p>${name}</p></body></html>`;
    const unsaved = (name: string) => `<!DOCTYPE html><html><head><title>${name}</title></head><body><p>${name}</p>` +
        '<script>window.dbmnSetTabDirty(true);</script></body></html>';

    async function mount(dbmn: { push(m: Record<string, unknown>): Promise<void> }, tabId: string, name: string, html: string) {
        await dbmn.push({ type: 'mountEmbeddedTab', tabId, tabType: 'batch', refId: tabId.split(':')[1], name, preview: false, html });
    }

    const tabs = (page: Page) => page.locator('.hub-tab');
    const tab = (page: Page, id: string) => page.locator(`.hub-tab[data-tab-id="${id}"]`);

    /** Focus on the Hub page itself, out of every tab's frame, without clicking a tab. */
    const onHubPage = (page: Page) => page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });

    /** What the web and desktop apps' bootstrap leaves on the page before any screen script. */
    const asWebApp = (page: Page) => page.addInitScript(() => { (window as unknown as { __dbmnHostQueue: unknown[] }).__dbmnHostQueue = []; });

    test('inside a tab, Alt+W closes that tab and only that tab', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await mount(dbmn, 'batch:one', 'One', clean('One'));
        await mount(dbmn, 'batch:two', 'Two', clean('Two'));
        const two = await dbmn.waitForTab('batch:two');
        await two.locator('p').click();
        await page.keyboard.press('Alt+w');
        await expect(tab(page, 'batch:two')).toHaveCount(0);
        await expect(tab(page, 'batch:one')).toHaveCount(1);
    });

    test('in VS Code the Hub page leaves Alt+W to the keybinding, which closes one tab', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await mount(dbmn, 'batch:one', 'One', clean('One'));
        await mount(dbmn, 'batch:two', 'Two', clean('Two'));
        await expect(tabs(page)).toHaveCount(2);
        await onHubPage(page);
        await page.keyboard.press('Alt+w');
        await page.waitForTimeout(300);
        await expect(tabs(page), 'the page itself does nothing: VS Code would close a second tab').toHaveCount(2);
        await dbmn.push({ type: 'closeActiveTabFromHost' });
        await expect(tabs(page)).toHaveCount(1);
    });

    test('in the web app, Alt+W on the Hub page closes the active tab', async ({ dbmn, page }) => {
        await asWebApp(page);
        await dbmn.openHub();
        await mount(dbmn, 'batch:one', 'One', clean('One'));
        await mount(dbmn, 'batch:two', 'Two', clean('Two'));
        await onHubPage(page);
        await page.keyboard.press('Alt+w');
        await expect(tab(page, 'batch:two')).toHaveCount(0);
        await expect(tab(page, 'batch:one')).toHaveCount(1);
    });

    test('a tab with unsaved work asks first', async ({ dbmn, page }) => {
        await asWebApp(page);
        await dbmn.openHub();
        await mount(dbmn, 'batch:one', 'One', unsaved('One'));
        await expect(tab(page, 'batch:one')).toHaveClass(/is-dirty/);
        const one = await dbmn.waitForTab('batch:one');
        await one.locator('p').click();
        await page.keyboard.press('Alt+w');
        await expect(page.locator('.dbmn-modal')).toBeVisible();
        await expect(tab(page, 'batch:one')).toHaveCount(1);
    });
});
