// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect } from '../harness/fixtures';

test.describe('Hub rail and page size', () => {
    // Issue #353: core.css pads every body; the Hub fills its webview, so it
    // must not be taller than the viewport (code could scroll the header away).
    test('the Hub is exactly as tall as its webview', async ({ dbmn, page }) => {
        await page.setViewportSize({ width: 900, height: 500 });
        await dbmn.openHub();
        await dbmn.settle();
        const [scrollHeight, viewport] = await page.evaluate(() => [document.scrollingElement!.scrollHeight, innerHeight]);
        expect(scrollHeight).toBe(viewport);
    });

    // Issue #293: in a short window rail icons keep their size; what doesn't
    // fit goes behind `…`, and Account / Settings stay put.
    test('a short rail moves items behind … instead of squashing them', async ({ dbmn, page }) => {
        await page.setViewportSize({ width: 900, height: 900 });
        await dbmn.openHub();
        await dbmn.settle();
        const more = page.locator('#hubNavMore');
        await expect(more).toBeHidden();
        const fullHeight = await page.locator('.hub-nav-item[data-section="environments"]').evaluate(el => el.getBoundingClientRect().height);

        await page.setViewportSize({ width: 900, height: 400 });
        await expect(more).toBeVisible();
        // (Logs, Account and Settings are pinned: they never move)
        for (const section of ['environments', 'catalogue', 'logs', 'account', 'settings']) {
            const item = page.locator(`.hub-nav-item[data-section="${section}"]`);
            await expect(item).toBeVisible();
            expect(await item.evaluate(el => el.getBoundingClientRect().height)).toBe(fullHeight);
        }
        await expect(page.locator('.hub-nav-item[data-section="export"]')).toBeHidden();

        await more.click();
        const popup = page.locator('#hubNavMorePopup');
        await expect(popup).toBeVisible();
        // Logs pinned beside Account and Settings leaves room for two top items at this height
        await expect(popup.locator('.hub-env-popup-item')).toHaveText(['History', 'Reporting', 'Import', 'Export']);
        await popup.locator('.hub-env-popup-item[data-section="export"]').click();
        await expect(popup).toBeHidden();
        await expect(page.locator('#hubTabStrip')).toContainText('Export');
        // The open tab's rail item is behind …, so … carries the highlight
        await expect(more).toHaveClass(/is-active/);

        // Room again: everything back on the rail, … gone
        await page.setViewportSize({ width: 900, height: 900 });
        await expect(more).toBeHidden();
        await expect(page.locator('.hub-nav-item[data-section="export"]')).toBeVisible();
    });
});
