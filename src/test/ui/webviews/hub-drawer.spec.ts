// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect, openList } from '../harness/fixtures';

// GitHub Issue #349: the Hub's lists (Environments, API Catalogue, History) live
// in a drawer over the tab content. A rail item toggles it; picking something
// that opens a tab closes it; the tab content never changes width.
test.describe('Hub list drawer', () => {
    const rail = (section: string) => `.hub-nav-item[data-section="${section}"]`;
    const DRAWER_OPEN = /drawer-open/;

    test('a rail item opens its list, the same item closes it, another switches lists', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const layout = page.locator('.hub-layout');
        await expect(layout).not.toHaveClass(DRAWER_OPEN);
        await expect(page.locator('.hub-nav-item.is-active')).toHaveCount(0);

        await page.locator(rail('catalogue')).click();
        await expect(layout).toHaveClass(DRAWER_OPEN);
        await expect(page.locator('.hub-section[data-section="catalogue"]')).toBeVisible();
        await expect(page.locator(rail('catalogue'))).toHaveClass(/is-active/);
        await expect(page.locator('#catalogueSearch')).toBeFocused();

        await page.locator(rail('environments')).click();
        await expect(layout).toHaveClass(DRAWER_OPEN);
        await expect(page.locator('.hub-section[data-section="environments"]')).toBeVisible();
        await expect(page.locator('.hub-section[data-section="catalogue"]')).toBeHidden();

        await page.locator(rail('environments')).click();
        await expect(layout).not.toHaveClass(DRAWER_OPEN);
        await expect(page.locator('.hub-main')).toBeHidden();
        await expect(page.locator('.hub-nav-item.is-active')).toHaveCount(0);
    });

    test('picking an environment opens its tab, closes the drawer and lights its rail item', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'environments');
        await page.locator('#hubEnvironmentList [data-env-id="env-prod-001"]').first().click();
        await dbmn.waitForTab('environment:env-prod-001');

        await expect(page.locator('.hub-layout')).not.toHaveClass(DRAWER_OPEN);
        await expect(page.locator(rail('environments'))).toHaveClass(/is-active/);
    });

    test('a catalogue click gives a preview tab, a double-click keeps it; both close the drawer', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        const layout = page.locator('.hub-layout');

        // Single click: the preview opens straight away; the drawer waits out
        // the double-click window before it closes.
        await page.locator('.catalogue-row[data-endpoint-id="test-endpoint-001"]').click();
        const single = await dbmn.waitForSent('openEndpointAsTab');
        expect(single.message.preview).toBe(true);
        await dbmn.waitForTab('endpoint:test-endpoint-001');
        await expect(layout).not.toHaveClass(DRAWER_OPEN);
        await expect(page.locator(rail('catalogue'))).toHaveClass(/is-active/);

        // Double-click: the row is still there for the second click, and the tab is kept.
        await openList(page, 'catalogue');
        const before = await dbmn.sentCount();
        await page.locator('.catalogue-row[data-endpoint-id="test-endpoint-002"]').dblclick();
        await dbmn.waitForTab('endpoint:test-endpoint-002');
        const opens = (await dbmn.sent('openEndpointAsTab')).slice(-3).map(s => s.message);
        expect(opens.map(m => m.preview)).toEqual([true, true, false]);
        expect(await dbmn.sentCount()).toBeGreaterThan(before);
        await expect(layout).not.toHaveClass(DRAWER_OPEN);
    });

    test('search, Select mode, group collapse and a filter modal leave the drawer open', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        const layout = page.locator('.hub-layout');

        await page.locator('#catalogueSearch').fill('Validation');
        await page.locator('#catalogueSearch').fill('');
        await page.locator('#catalogueList .catalogue-group-header').first().click();
        await page.locator('#catalogueList label.hub-add-split-select').click();
        await page.locator('#catalogueList .catalogue-row-select').first().check();
        await expect(layout).toHaveClass(DRAWER_OPEN);

        // Escape closes the modal first, not the drawer.
        await page.locator('#catalogueFilterBtn').click();
        await expect(page.locator('.dbmn-modal')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.dbmn-modal')).toHaveCount(0);
        await expect(layout).toHaveClass(DRAWER_OPEN);
    });

    test('Escape and a click on the dimmed tab content close the drawer', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const layout = page.locator('.hub-layout');

        await openList(page, 'catalogue');
        await page.keyboard.press('Escape');
        await expect(layout).not.toHaveClass(DRAWER_OPEN);
        await expect(page.locator(rail('catalogue'))).toBeFocused();

        await openList(page, 'catalogue');
        await page.locator('#hubDrawerScrim').click({ position: { x: 600, y: 300 } });
        await expect(layout).not.toHaveClass(DRAWER_OPEN);
    });

    test('Import, Export, Account and Settings close the drawer', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        await page.locator(rail('settings')).click();
        await expect(page.locator('.hub-layout')).not.toHaveClass(DRAWER_OPEN);
        await expect(page.locator(rail('settings'))).toHaveClass(/is-active/);
    });

    test('the tab content keeps its width while the drawer opens over it', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        await page.locator('.catalogue-row[data-endpoint-id="test-endpoint-001"]').dblclick();
        await dbmn.waitForTab('endpoint:test-endpoint-001');
        await expect(page.locator('.hub-layout')).not.toHaveClass(DRAWER_OPEN);
        await dbmn.settle();

        const content = page.locator('#hubContent');
        const closed = await content.boundingBox();
        await openList(page, 'catalogue');
        const open = await content.boundingBox();
        expect(open).toEqual(closed);
        await dbmn.settle();
        await expect(page).toHaveScreenshot('drawer-over-tab.png', {
            mask: [dbmn.tab('endpoint:test-endpoint-001').locator('#monacoEditorContainer')]
        });
    });

    test('the drawer width persists through the host', async ({ dbmn, page }) => {
        dbmn.seed.hubPreferences = { hubCol2Width: '420px' };
        await dbmn.openHub();
        await openList(page, 'catalogue');
        const main = page.locator('.hub-main');
        await expect.poll(async () => (await main.boundingBox())?.width).toBe(420);

        const handle = page.locator('#hubColResize');
        const before = await dbmn.sentCount();
        await handle.focus();
        await page.keyboard.press('ArrowRight');
        const msg = await dbmn.waitForSent('setHubPreferences', { after: before });
        expect(msg.message.preferences).toMatchObject({ hubCol2Width: '444px' });
        await expect.poll(async () => (await main.boundingBox())?.width).toBe(444);
    });
});
