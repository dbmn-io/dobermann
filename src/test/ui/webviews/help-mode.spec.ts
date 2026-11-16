// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect, openList } from '../harness/fixtures';

// Help mode, DBMN-wide: one button in the Hub header turns it on for the Hub and every tab;
// documented controls are outlined and open their dbmn.io section instead of doing their job.
test.describe('Help mode', () => {
    test('the Hub button turns it on in the Hub and the open tab; Esc in the tab turns it off everywhere', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        await page.locator('.catalogue-row[data-endpoint-id="test-endpoint-001"]').click();
        await dbmn.waitForSent('openEndpointAsTab');
        const tab = await dbmn.waitForTab('endpoint:test-endpoint-001');

        const toggle = page.locator('#hubHelpToggle');
        await expect(toggle).toBeVisible();
        await toggle.click();
        await expect(page.locator('body')).toHaveClass(/help-mode/);
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.help-mode-banner')).toBeVisible();

        // The tab follows the Hub, and outlines its documented controls (no banner of its own).
        await expect(tab.locator('body')).toHaveClass(/help-mode/);
        await expect(tab.locator('#save-endpoint-btn')).toHaveClass(/help-mode-target/);
        await expect(tab.locator('.help-mode-banner')).toHaveCount(0);

        // The Hub's own controls are documented too, and the button itself is not a target.
        await expect(page.locator('#hubEnvSelector')).toHaveClass(/help-mode-target/);
        await expect(toggle).not.toHaveClass(/help-mode-target/);

        // Esc while the tab has focus ends it for the Hub too.
        await tab.locator('h2[data-help="endpoints#request-body"]').hover();
        await tab.locator('body').press('Escape');
        await expect(page.locator('body')).not.toHaveClass(/help-mode/);
        await expect(tab.locator('body')).not.toHaveClass(/help-mode/);
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    test('a list outlines only its first visible row, plus the add row\'s Select, Add and Paste', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        await page.locator('#hubHelpToggle').click();
        const rows = page.locator('#catalogueList .catalogue-row.help-mode-target');
        await expect(rows).toHaveCount(1);
        await expect(page.locator('#catalogueList .catalogue-row').first()).toHaveClass(/help-mode-target/);
        await expect(page.locator('#catalogueList .catalogue-row-run-api.help-mode-target')).toHaveCount(1);
        await expect(page.locator('#catalogueList .hub-add-split-select')).toHaveClass(/help-mode-target/);
        await expect(page.locator('#catalogueList .hub-add-split-primary')).toHaveClass(/help-mode-target/);
        await expect(page.locator('#catalogueList .hub-add-split-alt')).toHaveClass(/help-mode-target/);

        // Every list works the same way: Environments outlines one environment, not all.
        await page.keyboard.press('Escape');
        await page.locator('.hub-nav-item[data-section="environments"]').click();
        await page.locator('#hubHelpToggle').click();
        expect(await page.locator('#hubEnvironmentList [data-env-id]').count()).toBeGreaterThan(1);
        await expect(page.locator('#hubEnvironmentList [data-env-id].help-mode-target')).toHaveCount(1);
        await expect(page.locator('#hubAddEnvironment')).toHaveClass(/help-mode-target/);
    });

    test('a documented control opens its docs instead of running', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await page.locator('#hubHelpToggle').click();
        await page.locator('.hub-nav-item[data-section="transactions"]').click();
        const opened = await dbmn.waitForSent('openExternalUrl');
        expect(JSON.stringify(opened)).toContain('https://dbmn.io/docs/hub/#history');
        // The rail did not open the History list.
        await expect(page.locator('.hub-layout')).not.toHaveClass(/drawer-open/);
        await expect(page.locator('.hub-nav-item[data-section="transactions"]')).not.toHaveClass(/is-active/);
    });

    // #372: an editor's buttons run through DbmnActions (data-click), not inline handlers. Help mode
    // still decides first: Save opens its docs and saves nothing.
    test('an editor\'s action button opens its docs in help mode, and does not run', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        await page.locator('.catalogue-row[data-endpoint-id="test-endpoint-001"]').click();
        const tab = await dbmn.waitForTab('endpoint:test-endpoint-001');
        await expect(tab.locator('#save-endpoint-btn')).toHaveAttribute('data-click', 'saveEndpoint');
        await page.locator('#hubHelpToggle').click();
        await expect(tab.locator('#save-endpoint-btn')).toHaveClass(/help-mode-target/);

        await tab.locator('#save-endpoint-btn').evaluate(button => { (button as HTMLButtonElement).disabled = false; });
        const before = await dbmn.sentCount();
        await tab.locator('#save-endpoint-btn').click();
        await dbmn.waitForSent('openExternalUrl', { after: before });
        expect((await dbmn.sent('saveEndpoint')).length, 'nothing saved').toBe(0);
    });
});
